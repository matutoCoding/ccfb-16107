import type { BakeChannelName, HallDoc, Vec3 } from '../types'
import type { BuiltSceneGeometry } from '../geometry/parametric_geometry'
import { objectModel } from '../geometry/parametric_geometry'
import { mat4, v3, type Mat4 } from '../math3d'
import type { ChartMeta } from '../types'

export interface OrbitCamera {
  target: Vec3
  yaw: number
  pitch: number
  distance: number
  fovYRad: number
}

export interface PreviewOverlay {
  // 质检标注：世界坐标点 + 颜色 + 文案
  markers: Array<{ position: Vec3; color: string; label: string }>
  highlightChartObjectId: string | null
  densityChart?: ChartMeta[]
}

export interface PreviewOptions {
  hall: HallDoc
  scene: BuiltSceneGeometry
  camera: OrbitCamera
  bakedChannels?: Record<BakeChannelName, Float32Array>
  atlas?: { size: number; charts: ChartMeta[] }
  overlay?: PreviewOverlay
  width: number
  height: number
}

interface ProjectedTri {
  points: Array<{ x: number; y: number; z: number; world: Vec3 }>
  depth: number
  fill: string
  stroke: string
  objectId: string
  surfaceId: number
}

// Canvas2D 软件光栅预览：画家算法排序，保证任何环境可用
// WebGPU 可用时上层改用 webgpu_raster_renderer，本类仍是发布端只读兜底
export class CanvasPreviewRenderer {
  render(ctx: CanvasRenderingContext2D, options: PreviewOptions): void {
    const { width, height, hall, scene, camera } = options
    ctx.clearRect(0, 0, width, height)
    this.drawBackground(ctx, width, height)

    const view = this.buildView(camera)
    const proj = this.buildProjection(camera.fovYRad, width / height)
    const tris: ProjectedTri[] = []

    scene.geometries.forEach((geo) => {
      const obj = hall.objects.find((o) => o.id === geo.objectId)
      if (!obj) return
      const model = objectModel(obj)
      const mvp = mat4.multiply(proj, mat4.multiply(view, model))
      const data = geo.triangles
      for (let i = 0; i < data.indices.length; i += 3) {
        const triIdx = [data.indices[i], data.indices[i + 1], data.indices[i + 2]]
        const projected = triIdx.map((vi) => {
          const local: Vec3 = [data.positions[vi * 3], data.positions[vi * 3 + 1], data.positions[vi * 3 + 2]]
          const world = mat4.transformPoint(model, local)
          const clip = mat4.transformPoint(mvp, local)
          return {
            x: (clip[0] * 0.5 + 0.5) * width,
            y: (1 - (clip[1] * 0.5 + 0.5)) * height,
            z: clip[2],
            world,
          }
        })
        if (projected.some((p) => p.z < -1 || p.z > 1)) continue
        const normal: Vec3 = [data.normals[triIdx[0] * 3], data.normals[triIdx[0] * 3 + 1], data.normals[triIdx[0] * 3 + 2]]
        const worldNormal = v3.normalize(mat4.transformDir(model, normal))
        const fill = this.shadeObject(obj, worldNormal, options)
        const highlighted = options.overlay?.highlightChartObjectId === obj.id
        tris.push({
          points: projected,
          depth: projected.reduce((s, p) => s + p.z, 0) / 3,
          fill: highlighted ? '#38bdf8' : fill,
          stroke: highlighted ? 'rgba(125,211,252,0.9)' : 'rgba(148,163,184,0.18)',
          objectId: obj.id,
          surfaceId: data.surfaceIds[triIdx[0]],
        })
      }
    })

    tris.sort((a, b) => b.depth - a.depth)
    for (const tri of tris) {
      ctx.beginPath()
      ctx.moveTo(tri.points[0].x, tri.points[0].y)
      tri.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y))
      ctx.closePath()
      ctx.fillStyle = tri.fill
      ctx.fill()
      ctx.strokeStyle = tri.stroke
      ctx.lineWidth = 1
      ctx.stroke()
    }

    this.drawLights(ctx, hall, view, proj, width, height)
    this.drawMarkers(ctx, options, view, proj, width, height)
  }

  private drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, '#0b1220')
    gradient.addColorStop(1, '#080d18')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
  }

  private buildView(camera: OrbitCamera): Mat4 {
    const eye = this.cameraEye(camera)
    const forward = v3.normalize(v3.sub(camera.target, eye))
    const helper: Vec3 = Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const right = v3.normalize(v3.cross(forward, helper))
    const up = v3.cross(right, forward)
    const view = mat4.identity()
    // 行组装旋转分量再平移
    view[0] = right[0]
    view[4] = right[1]
    view[8] = right[2]
    view[1] = up[0]
    view[5] = up[1]
    view[9] = up[2]
    view[2] = -forward[0]
    view[6] = -forward[1]
    view[10] = -forward[2]
    view[12] = -v3.dot(right, eye)
    view[13] = -v3.dot(up, eye)
    view[14] = v3.dot(forward, eye)
    return view
  }

  cameraEye(camera: OrbitCamera): Vec3 {
    const cp = Math.cos(camera.pitch)
    return [
      camera.target[0] + camera.distance * cp * Math.sin(camera.yaw),
      camera.target[1] + camera.distance * Math.sin(camera.pitch),
      camera.target[2] + camera.distance * cp * Math.cos(camera.yaw),
    ]
  }

  private buildProjection(fovYRad: number, aspect: number): Mat4 {
    const f = 1 / Math.tan(fovYRad / 2)
    const near = 0.1
    const far = 100
    const m = new Float32Array(16)
    m[0] = f / aspect
    m[5] = f
    m[10] = (far + near) / (near - far)
    m[11] = -1
    m[14] = (2 * far * near) / (near - far)
    m[15] = 1
    return m
  }

  private shadeObject(
    obj: HallDoc['objects'][number],
    normal: Vec3,
    options: PreviewOptions,
  ): string {
    const base = obj.material.baseColor
    // 有烘焙结果时用图集颜色调制；无烘焙时用灯方向做简单 Lambert
    let lightFactor = 0.35
    for (const light of options.hall.lights) {
      const dir = v3.normalize(v3.sub(light.position, obj.position))
      lightFactor += Math.max(0, v3.dot(normal, dir)) * 0.28 * light.intensity
    }
    lightFactor = Math.min(1.15, lightFactor)
    const r = Math.round(Math.min(255, base[0] * 255 * lightFactor))
    const g = Math.round(Math.min(255, base[1] * 255 * lightFactor))
    const b = Math.round(Math.min(255, base[2] * 255 * lightFactor))
    if (obj.material.kind === 'glass') return `rgba(${r},${g},${b},0.32)`
    return `rgb(${r},${g},${b})`
  }

  private drawLights(ctx: CanvasRenderingContext2D, hall: HallDoc, view: Mat4, proj: Mat4, width: number, height: number): void {
    for (const light of hall.lights) {
      const clip = mat4.transformPoint(mat4.multiply(proj, view), light.position)
      if (clip[2] < -1 || clip[2] > 1) continue
      const x = (clip[0] * 0.5 + 0.5) * width
      const y = (1 - (clip[1] * 0.5 + 0.5)) * height
      ctx.beginPath()
      ctx.arc(x, y, light.kind === 'skylight' ? 7 : 5, 0, Math.PI * 2)
      ctx.fillStyle = light.kind === 'skylight' ? '#7dd3fc' : '#fbbf24'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.stroke()
    }
  }

  private drawMarkers(ctx: CanvasRenderingContext2D, options: PreviewOptions, view: Mat4, proj: Mat4, width: number, height: number): void {
    const markers = options.overlay?.markers ?? []
    for (const marker of markers) {
      const clip = mat4.transformPoint(mat4.multiply(proj, view), marker.position)
      if (clip[2] < -1 || clip[2] > 1) continue
      const x = (clip[0] * 0.5 + 0.5) * width
      const y = (1 - (clip[1] * 0.5 + 0.5)) * height
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fillStyle = marker.color
      ctx.fill()
      ctx.font = '12px sans-serif'
      ctx.fillStyle = '#e2e8f0'
      ctx.fillText(marker.label, x + 7, y - 6)
    }
  }
}
