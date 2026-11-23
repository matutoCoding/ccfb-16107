import type { BakeChannelName, ChartMeta, HallDoc, IesProfile, LightConfig, Vec3 } from '../types'
import type { BuiltBvh } from '../bvh'
import type { BuiltSceneGeometry } from '../geometry/parametric_geometry'
import { PATH_TRACE_WGSL } from './path_trace_wgsl'
import { sampleChartSurface } from '../surface_sampler'
import { v3 } from '../math3d'

// WebGPU compute 烘焙器：与 CpuPathTracer 输出同构，按 chart 逐个 dispatch
// 设备不支持 compute 或 kernel 编译失败时，上层回落到 CPU 路径
export class WebGpuComputeBaker {
  private pipeline: GPUComputePipeline | null = null
  private module: GPUShaderModule | null = null

  constructor(private readonly device: GPUDevice) {}

  async compile(): Promise<boolean> {
    try {
      this.module = this.device.createShaderModule({ code: PATH_TRACE_WGSL })
      // pipeline 创建即完成编译校验，非法 WGSL 会在此抛错
      this.pipeline = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.module, entryPoint: 'main' },
      })
      return true
    } catch {
      return false
    }
  }

  async bakeChart(
    hall: HallDoc,
    scene: BuiltSceneGeometry,
    bvh: BuiltBvh,
    chart: ChartMeta,
    _iesById: Map<string, IesProfile>,
  ): Promise<Record<BakeChannelName, Float32Array> | null> {
    if (!this.pipeline) return null
    try {
      return await this.dispatchChart(hall, scene, bvh, chart)
    } catch (err) {
      console.warn('WebGPU 烘焙 dispatch 失败，回落 CPU：', err)
      return null
    }
  }

  private async dispatchChart(
    hall: HallDoc,
    scene: BuiltSceneGeometry,
    bvh: BuiltBvh,
    chart: ChartMeta,
  ): Promise<Record<BakeChannelName, Float32Array>> {
    const device = this.device
    const atlasSize = hall.bakeSettings.atlasSize
    const nodeBuffer = this.uploadNodes(bvh)
    const triBuffer = this.uploadTriangles(bvh)
    const lightBuffer = this.uploadLights(hall.lights)
    const { pointBuffer, normalBuffer } = this.uploadSurfaces(hall, scene, chart)
    const directBuffer = device.createBuffer({ size: atlasSize * atlasSize * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const indirectBuffer = device.createBuffer({ size: atlasSize * atlasSize * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const aoBuffer = device.createBuffer({ size: atlasSize * atlasSize * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })

    const uniformData = new Float32Array(16)
    uniformData[0] = atlasSize
    uniformData[1] = hall.bakeSettings.samplesPerPixel
    uniformData[2] = hall.bakeSettings.bounceCount
    uniformData[3] = hall.lights.length
    uniformData[4] = chart.x
    uniformData[5] = chart.y
    uniformData[6] = chart.widthPx
    uniformData[7] = chart.heightPx
    uniformData[8] = Math.abs(hashCode(chart.id)) % 100000
    const uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(uniformBuffer, 0, uniformData)

    const bindGroup = device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: nodeBuffer } },
        { binding: 2, resource: { buffer: triBuffer } },
        { binding: 3, resource: { buffer: lightBuffer } },
        { binding: 4, resource: { buffer: pointBuffer } },
        { binding: 5, resource: { buffer: normalBuffer } },
        { binding: 6, resource: { buffer: directBuffer } },
        { binding: 7, resource: { buffer: indirectBuffer } },
        { binding: 8, resource: { buffer: aoBuffer } },
      ],
    })

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipeline!)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(chart.widthPx / 8), Math.ceil(chart.heightPx / 8))
    pass.end()
    device.queue.submit([encoder.finish()])
    await device.queue.onSubmittedWorkDone()

    const [direct, indirect, ao] = await Promise.all([
      this.readChannel(directBuffer, atlasSize),
      this.readChannel(indirectBuffer, atlasSize),
      this.readChannel(aoBuffer, atlasSize),
    ])
    return { direct, indirect, ao }
  }

  private async readChannel(buffer: GPUBuffer, size: number): Promise<Float32Array> {
    const device = this.device
    const readback = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(buffer, 0, readback, 0, buffer.size)
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const rgba = new Float32Array(readback.getMappedRange().slice(0))
    readback.unmap()
    const rgb = new Float32Array(size * size * 3)
    for (let i = 0; i < size * size; i++) {
      rgb[i * 3] = rgba[i * 4]
      rgb[i * 3 + 1] = rgba[i * 4 + 1]
      rgb[i * 3 + 2] = rgba[i * 4 + 2]
    }
    readback.destroy()
    return rgb
  }

  private uploadNodes(bvh: BuiltBvh): GPUBuffer {
    // 每个节点 32 字节：min(12)+max(12)+4 个 i32(16)，按 16 对齐补 4
    const data = new Float32Array(bvh.nodes.length * 8)
    const ints = new Int32Array(data.buffer)
    bvh.nodes.forEach((n, i) => {
      const base = i * 8
      data[base] = n.minX
      data[base + 1] = n.minY
      data[base + 2] = n.minZ
      data[base + 3] = n.maxX
      data[base + 4] = n.maxY
      data[base + 5] = n.maxZ
      ints[base * 4 + 24] = n.left
      ints[base * 4 + 25] = n.right
      ints[base * 4 + 26] = n.firstTri
      ints[base * 4 + 27] = n.triCount
    })
    const buffer = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  private uploadTriangles(bvh: BuiltBvh): GPUBuffer {
    // 每三角形 48 字节：v0/v1/v2/normal 各 vec3 + 2 个 u32
    const data = new Float32Array(bvh.triangles.length * 12)
    const ints = new Int32Array(data.buffer)
    bvh.triangles.forEach((t, i) => {
      const base = i * 12
      data.set(t.v0, base)
      data.set(t.v1, base + 3)
      data.set(t.v2, base + 6)
      const normal = v3.normalize(t.n0)
      data.set(normal, base + 9)
      ints[base * 4 + 44] = hashCode(t.objectId)
      ints[base * 4 + 45] = t.surfaceId
    })
    const buffer = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  private uploadLights(lights: LightConfig[]): GPUBuffer {
    // 每灯 48 字节
    const data = new Float32Array(Math.max(1, lights.length) * 12)
    const ints = new Int32Array(data.buffer)
    const kindMap: Record<LightConfig['kind'], number> = { spot: 0, wallwash: 1, linear: 2, skylight: 3 }
    lights.forEach((l, i) => {
      const base = i * 12
      data.set(l.position, base)
      data.set(l.target, base + 3)
      data.set(l.color, base + 6)
      data[base + 9] = l.intensity
      data[base + 10] = l.beamAngle
      data[base + 11] = l.length
      ints[base * 4 + 48] = kindMap[l.kind]
      ints[base * 4 + 49] = l.castShadow ? 1 : 0
    })
    const buffer = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  private uploadSurfaces(hall: HallDoc, scene: BuiltSceneGeometry, chart: ChartMeta): { pointBuffer: GPUBuffer; normalBuffer: GPUBuffer } {
    const count = chart.widthPx * chart.heightPx
    const points = new Float32Array(count * 4)
    const normals = new Float32Array(count * 4)
    for (let py = 0; py < chart.heightPx; py++) {
      for (let px = 0; px < chart.widthPx; px++) {
        const u = (px + 0.5) / chart.widthPx
        const v = (py + 0.5) / chart.heightPx
        const sample = sampleChartSurface(hall, scene, chart, u, v)
        const idx = (py * chart.widthPx + px) * 4
        if (sample) {
          points.set([...sample.point, 1], idx)
          normals.set([...sample.normal, 1], idx)
        } else {
          points.set([0, 0, 0, 1], idx)
          normals.set([0, 1, 0, 1], idx)
        }
      }
    }
    const pointBuffer = this.device.createBuffer({ size: points.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const normalBuffer = this.device.createBuffer({ size: normals.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(pointBuffer, 0, points)
    this.device.queue.writeBuffer(normalBuffer, 0, normals)
    return { pointBuffer, normalBuffer }
  }
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h
}
