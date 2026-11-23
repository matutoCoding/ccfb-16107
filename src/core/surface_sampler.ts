import type { ChartMeta, HallDoc, Vec3 } from './types'
import type { BuiltSceneGeometry } from './geometry/parametric_geometry'
import { objectModel } from './geometry/parametric_geometry'
import { buildLatheGeometry } from './geometry/lathe_geometry'
import { mat4, v3 } from './math3d'

export interface SurfaceSample {
  point: Vec3
  normal: Vec3
}

// box 六面的局部空间参数化：u/v 与 box_geometry 顶点 uv 规则保持一致
function sampleBox(hall: HallDoc, chart: ChartMeta, u: number, v: number): SurfaceSample | null {
  const obj = hall.objects.find((o) => o.id === chart.objectId)
  if (!obj) return null
  const [sx, sy, sz] = obj.size
  const hx = sx / 2
  const hy = sy / 2
  const hz = sz / 2
  let local: Vec3
  let normal: Vec3
  switch (chart.surfaceTag) {
    case 'px':
      local = [hx, -hy + v * sy, -hz + u * sz]
      normal = [1, 0, 0]
      break
    case 'nx':
      local = [-hx, -hy + v * sy, hz - u * sz]
      normal = [-1, 0, 0]
      break
    case 'py':
      local = [-hx + u * sx, hy, -hz + v * sz]
      normal = [0, 1, 0]
      break
    case 'ny':
      local = [-hx + u * sx, -hy, hz - v * sz]
      normal = [0, -1, 0]
      break
    case 'pz':
      local = [-hx + u * sx, -hy + v * sy, hz]
      normal = [0, 0, 1]
      break
    case 'nz':
      local = [hx - u * sx, -hy + v * sy, -hz]
      normal = [0, 0, -1]
      break
    default:
      return null
  }
  const model = objectModel(obj)
  return { point: mat4.transformPoint(model, local), normal: v3.normalize(mat4.transformDir(model, normal)) }
}

// 回转面：u=转角，v=剖面高度，与 lathe_geometry 的 worldToSurface 互逆
function sampleLathe(hall: HallDoc, chart: ChartMeta, u: number, v: number): SurfaceSample | null {
  const obj = hall.objects.find((o) => o.id === chart.objectId)
  if (!obj) return null
  const geo = buildLatheGeometry(obj, obj.kind)
  const patch = geo.patches.find((p) => p.tag === chart.surfaceTag)
  if (!patch) return null
  // 直接复用几何顶点插值：u/v 落到最近的网格环带
  const data = geo.triangles
  const radialSegments = 32
  const heightSegments = 24
  const col = Math.min(radialSegments - 1, Math.floor(u * radialSegments))
  const row = Math.min(heightSegments - 1, Math.floor(v * heightSegments))
  const rowSize = radialSegments + 1
  const base = row * rowSize + col
  const fu = u * radialSegments - col
  const fv = v * heightSegments - row
  const readV = (idx: number, offset: number): number => data.positions[idx * 3 + offset]
  const readN = (idx: number, offset: number): number => data.normals[idx * 3 + offset]
  const lerpVertex = (offset: number, useNormal: boolean): number => {
    const buf = useNormal ? readN : readV
    const a = buf(base, offset)
    const b = buf(base + 1, offset)
    const c = buf(base + rowSize, offset)
    const d = buf(base + rowSize + 1, offset)
    return a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + c * (1 - fu) * fv + d * fu * fv
  }
  const local: Vec3 = [lerpVertex(0, false), lerpVertex(1, false), lerpVertex(2, false)]
  const normal: Vec3 = v3.normalize([lerpVertex(0, true), lerpVertex(1, true), lerpVertex(2, true)])
  const model = objectModel(obj)
  return { point: mat4.transformPoint(model, local), normal: v3.normalize(mat4.transformDir(model, normal)) }
}

function sampleScroll(hall: HallDoc, chart: ChartMeta, u: number, v: number): SurfaceSample | null {
  const obj = hall.objects.find((o) => o.id === chart.objectId)
  if (!obj) return null
  const [w, h] = obj.size
  const local: Vec3 = [-w / 2 + u * w, -h / 2 + v * h, 0]
  const normal: Vec3 = [0, 0, 1]
  const model = objectModel(obj)
  return { point: mat4.transformPoint(model, local), normal: v3.normalize(mat4.transformDir(model, normal)) }
}

// 纹素中心（加亚像素抖动）-> 世界表面点与法线
export function sampleChartSurface(
  hall: HallDoc,
  scene: BuiltSceneGeometry,
  chart: ChartMeta,
  u: number,
  v: number,
): SurfaceSample | null {
  const geoIndex = scene.indexById.get(chart.objectId)
  if (geoIndex === undefined) return null
  const kind = scene.geometries[geoIndex].kind
  if (kind === 'vase' || kind === 'ding') return sampleLathe(hall, chart, u, v)
  if (kind === 'scroll') return sampleScroll(hall, chart, u, v)
  return sampleBox(hall, chart, u, v)
}
