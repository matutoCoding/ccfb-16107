import type {
  BakeChannelName,
  ChartMeta,
  HallDoc,
  IesProfile,
  LightConfig,
  MaterialConfig,
  Vec3,
} from './types'
import type { BuiltBvh, RayHit } from './bvh'
import { traceRay } from './bvh'
import type { BuiltSceneGeometry } from './geometry/parametric_geometry'
import { makeLcg, v3, degToRad, clamp } from './math3d'
import { sampleIes } from './ies'
import { sampleChartSurface, type SurfaceSample } from './surface_sampler'

export interface ChartBakeOutput {
  chartId: string
  width: number
  height: number
  // 顺序与通道对应，逐像素 RGB（AO 三通道同值）
  pixels: Record<BakeChannelName, Float32Array>
}

interface TracerDeps {
  hall: HallDoc
  bvh: BuiltBvh
  scene: BuiltSceneGeometry
  iesById: Map<string, IesProfile>
}

const EPS = 0.002

function materialOf(deps: TracerDeps, objectId: string): MaterialConfig {
  const obj = deps.hall.objects.find((o) => o.id === objectId)
  return obj?.material ?? { kind: 'matte', baseColor: [0.6, 0.6, 0.6], roughness: 1, metallic: 0, patternStrength: 0 }
}

function brdfWeight(mat: MaterialConfig, wo: Vec3, wi: Vec3, normal: Vec3): Vec3 {
  const ndotl = Math.max(0, v3.dot(wi, normal))
  const diffuse = mat.baseColor.map((c) => (c / Math.PI) * ndotl) as Vec3
  if (mat.metallic <= 0) return diffuse
  const half = v3.normalize(v3.add(wo, wi))
  const spec = Math.pow(Math.max(0, v3.dot(half, normal)), 32) * mat.metallic
  return [diffuse[0] + spec, diffuse[1] + spec, diffuse[2] + spec]
}

// 构造以法线为 +Y 的局部坐标，余弦加权半球采样
function sampleHemisphere(normal: Vec3, rng: () => number): Vec3 {
  const r1 = rng() * 2 * Math.PI
  const r2 = rng()
  const r2s = Math.sqrt(r2)
  const helper: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const tangent = v3.normalize(v3.cross(helper, normal))
  const bitangent = v3.cross(normal, tangent)
  const local: Vec3 = [Math.cos(r1) * r2s, Math.sqrt(1 - r2), Math.sin(r1) * r2s]
  return v3.normalize([
    tangent[0] * local[0] + normal[0] * local[1] + bitangent[0] * local[2],
    tangent[1] * local[0] + normal[1] * local[1] + bitangent[1] * local[2],
    tangent[2] * local[0] + normal[2] * local[1] + bitangent[2] * local[2],
  ])
}

// 直接光：对每盏灯做下一事件估计，射灯走 IES 配光
function sampleDirectLight(deps: TracerDeps, point: Vec3, normal: Vec3, objectId: string, rng: () => number): Vec3 {
  let accum: Vec3 = [0, 0, 0]
  for (const light of deps.hall.lights) {
    const sample = sampleLightPoint(light, rng)
    const toLight = v3.sub(sample.point, point)
    const dist = v3.length(toLight)
    const wi = v3.scale(toLight, 1 / dist)
    const ndotl = v3.dot(wi, normal)
    if (ndotl <= 0) continue
    const shadow = traceRay(deps.bvh, v3.add(point, v3.scale(normal, EPS)), wi, dist - EPS)
    if (shadow) continue
    const attenuation = 1 / (dist * dist + 0.5)
    const beam = lightBeamFactor(deps, light, v3.scale(wi, -1))
    const radiance = light.color.map((c) => c * light.intensity * attenuation * beam * sample.areaWeight) as Vec3
    const mat = materialOf(deps, objectId)
    const weight = brdfWeight(mat, v3.scale(wi, -1), wi, normal)
    accum = v3.add(accum, [radiance[0] * weight[0], radiance[1] * weight[1], radiance[2] * weight[2]])
  }
  return accum
}

function sampleLightPoint(light: LightConfig, rng: () => number): { point: Vec3; areaWeight: number } {
  if (light.kind === 'linear') {
    const t = rng() - 0.5
    const dir = v3.normalize(v3.sub(light.target, light.position))
    const side: Vec3 = [dir[2], 0, -dir[0]]
    return { point: v3.add(light.position, v3.scale(side, t * light.length)), areaWeight: light.length }
  }
  if (light.kind === 'skylight') {
    const jitter: Vec3 = [(rng() - 0.5) * 2, 0, (rng() - 0.5) * 2]
    return { point: v3.add(light.position, jitter), areaWeight: 1 }
  }
  return { point: light.position, areaWeight: 1 }
}

function lightBeamFactor(deps: TracerDeps, light: LightConfig, outDir: Vec3): number {
  const forward = v3.normalize(v3.sub(light.target, light.position))
  const cosAngle = clamp(v3.dot(forward, outDir), -1, 1)
  const angleDeg = (Math.acos(cosAngle) * 180) / Math.PI
  if (light.kind === 'spot') {
    if (light.iesProfileId) {
      const ies = deps.iesById.get(light.iesProfileId)
      if (ies) return sampleIes(ies, angleDeg)
    }
    const half = degToRad(light.beamAngle)
    return Math.pow(clamp(cosAngle - Math.cos(half * 1.6), 0, 1), 2)
  }
  if (light.kind === 'wallwash') return clamp(1 - angleDeg / 90, 0.05, 1)
  if (light.kind === 'linear') return clamp(cosAngle + 0.2, 0.1, 1)
  return 1
}

// AO：固定半径内半球可见比例
function ambientOcclusion(deps: TracerDeps, point: Vec3, normal: Vec3, rng: () => number, samples: number): number {
  let visible = 0
  for (let i = 0; i < samples; i++) {
    const dir = sampleHemisphere(normal, rng)
    const blocked = traceRay(deps.bvh, v3.add(point, v3.scale(normal, EPS)), dir, 1.5)
    if (!blocked) visible++
  }
  return visible / samples
}

// 间接光：余弦采样路径追踪，弹射次数由设置控制
function traceIndirect(deps: TracerDeps, point: Vec3, normal: Vec3, objectId: string, rng: () => number, bounces: number): Vec3 {
  if (bounces <= 0) return [0, 0, 0]
  const wi = sampleHemisphere(normal, rng)
  const next = traceRay(deps.bvh, v3.add(point, v3.scale(normal, EPS)), wi)
  if (!next) return [0, 0, 0]
  const direct = sampleDirectLight(deps, next.point, next.normal, next.objectId, rng)
  const deeper = traceIndirect(deps, next.point, next.normal, next.objectId, rng, bounces - 1)
  const mat = materialOf(deps, objectId)
  const throughput = mat.baseColor.map((c) => c * v3.dot(wi, normal) * 2) as Vec3
  const incoming = v3.add(direct, deeper)
  return [incoming[0] * throughput[0], incoming[1] * throughput[1], incoming[2] * throughput[2]]
}

export class CpuPathTracer {
  constructor(private deps: TracerDeps) {}

  // 烘焙单个 chart：逐纹素多采样累积，分块调度时由调用方让出主线程
  bakeChart(chart: ChartMeta, onProgress?: (p: number) => void): ChartBakeOutput {
    const width = chart.widthPx
    const height = chart.heightPx
    const direct = new Float32Array(width * height * 3)
    const indirect = new Float32Array(width * height * 3)
    const ao = new Float32Array(width * height * 3)
    const rng = makeLcg(hashChartId(chart.id))
    const samples = this.deps.hall.bakeSettings.samplesPerPixel
    const bounces = this.deps.hall.bakeSettings.bounceCount

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = py * width + px
        const sum = this.accumulatePixel(chart, px, py, rng, samples, bounces)
        direct[idx * 3] = sum.direct[0] / samples
        direct[idx * 3 + 1] = sum.direct[1] / samples
        direct[idx * 3 + 2] = sum.direct[2] / samples
        indirect[idx * 3] = sum.indirect[0] / samples
        indirect[idx * 3 + 1] = sum.indirect[1] / samples
        indirect[idx * 3 + 2] = sum.indirect[2] / samples
        const aoValue = sum.ao / samples
        ao[idx * 3] = aoValue
        ao[idx * 3 + 1] = aoValue
        ao[idx * 3 + 2] = aoValue
      }
      onProgress?.((py + 1) / height)
    }
    return { chartId: chart.id, width, height, pixels: { direct, indirect, ao } }
  }

  private accumulatePixel(
    chart: ChartMeta,
    px: number,
    py: number,
    rng: () => number,
    samples: number,
    bounces: number,
  ): { direct: Vec3; indirect: Vec3; ao: number } {
    const direct: Vec3 = [0, 0, 0]
    const indirect: Vec3 = [0, 0, 0]
    let aoSum = 0
    for (let s = 0; s < samples; s++) {
      const surface = this.surfaceAt(chart, px, py, rng)
      if (!surface) continue
      const d = sampleDirectLight(this.deps, surface.point, surface.normal, chart.objectId, rng)
      const i = traceIndirect(this.deps, surface.point, surface.normal, chart.objectId, rng, bounces)
      direct[0] += d[0]
      direct[1] += d[1]
      direct[2] += d[2]
      indirect[0] += i[0]
      indirect[1] += i[1]
      indirect[2] += i[2]
      aoSum += ambientOcclusion(this.deps, surface.point, surface.normal, rng, 4)
    }
    return { direct, indirect, ao: aoSum }
  }

  // 纹素 -> 参数表面点，亚像素抖动保证抗锯齿
  private surfaceAt(chart: ChartMeta, px: number, py: number, rng: () => number): SurfaceSample | null {
    const u = (px + rng()) / chart.widthPx
    const v = (py + rng()) / chart.heightPx
    return sampleChartSurface(this.deps.hall, this.deps.scene, chart, u, v)
  }
}

// 参考图渲染：相机射线版路径追踪，逐像素返回辐照度，用于误差对比
export function renderReferenceFrame(
  deps: TracerDeps,
  width: number,
  height: number,
  camOrigin: Vec3,
  camForward: Vec3,
  fovYRad: number,
  samples: number,
  onProgress?: (p: number) => void,
): Float32Array {
  const frame = new Float32Array(width * height * 3)
  const helper: Vec3 = Math.abs(camForward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const right = v3.normalize(v3.cross(camForward, helper))
  const up = v3.cross(right, camForward)
  const tanHalf = Math.tan(fovYRad / 2)
  const rng = makeLcg(987654321)

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const color: Vec3 = [0, 0, 0]
      for (let s = 0; s < samples; s++) {
        const nx = ((px + rng()) / width) * 2 - 1
        const ny = 1 - ((py + rng()) / height) * 2
        const dir = v3.normalize([
          camForward[0] + right[0] * nx * tanHalf * (width / height) + up[0] * ny * tanHalf,
          camForward[1] + right[1] * nx * tanHalf * (width / height) + up[1] * ny * tanHalf,
          camForward[2] + right[2] * nx * tanHalf * (width / height) + up[2] * ny * tanHalf,
        ])
        const hit = traceRay(deps.bvh, camOrigin, dir)
        if (!hit) continue
        const direct = sampleDirectLight(deps, hit.point, hit.normal, hit.objectId, rng)
        const indirect = traceIndirect(deps, hit.point, hit.normal, hit.objectId, rng, deps.hall.bakeSettings.bounceCount)
        const mat = materialOf(deps, hit.objectId)
        color[0] += (direct[0] + indirect[0]) * (0.3 + mat.baseColor[0])
        color[1] += (direct[1] + indirect[1]) * (0.3 + mat.baseColor[1])
        color[2] += (direct[2] + indirect[2]) * (0.3 + mat.baseColor[2])
      }
      const idx = (py * width + px) * 3
      frame[idx] = color[0] / samples
      frame[idx + 1] = color[1] / samples
      frame[idx + 2] = color[2] / samples
    }
    onProgress?.((py + 1) / height)
  }
  return frame
}

function hashChartId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}
