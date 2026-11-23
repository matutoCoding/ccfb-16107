import type { ObjectGeometry, SurfacePatch, TriAccumulator } from './parametric_geometry'
import { boundsOf, finalize, resetTriAccumulator } from './parametric_geometry'
import type { ObjectKind, SceneObject, Vec3 } from '../types'
import { clamp, mat4 } from '../math3d'

export interface LatheProfilePoint {
  // 归一化高度 0~1
  t: number
  // 归一化半径 0~1，最终乘物体 size.x / 2
  r: number
}

// 瓷瓶剖面：窄底、鼓腹、收颈、敞口
export const VASE_PROFILE: LatheProfilePoint[] = [
  { t: 0, r: 0.28 },
  { t: 0.08, r: 0.34 },
  { t: 0.3, r: 0.52 },
  { t: 0.5, r: 0.5 },
  { t: 0.68, r: 0.34 },
  { t: 0.82, r: 0.2 },
  { t: 0.92, r: 0.24 },
  { t: 1, r: 0.36 },
]

// 青铜鼎剖面：宽腹、平底、微收口，鼎耳/鼎足用盒式附件在场景中另挂
export const DING_PROFILE: LatheProfilePoint[] = [
  { t: 0, r: 0.5 },
  { t: 0.12, r: 0.56 },
  { t: 0.5, r: 0.62 },
  { t: 0.8, r: 0.6 },
  { t: 0.92, r: 0.54 },
  { t: 1, r: 0.52 },
]

function profileRadiusAt(profile: LatheProfilePoint[], t: number): number {
  const x = clamp(t, 0, 1)
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i]
    const b = profile[i + 1]
    if (x >= a.t && x <= b.t) {
      const k = (x - a.t) / (b.t - a.t || 1)
      return a.r + (b.r - a.r) * k
    }
  }
  return profile[profile.length - 1].r
}

function pushVertex(acc: TriAccumulator, p: Vec3, n: Vec3, surfaceId: number): void {
  acc.positions.push(p[0], p[1], p[2])
  acc.normals.push(n[0], n[1], n[2])
  acc.surfaceIds.push(surfaceId)
  acc.vertexCount++
}

// 回转体几何：u=转角 0~1，v=剖面高度 0~1
export function buildLatheGeometry(obj: SceneObject, kind: ObjectKind): ObjectGeometry {
  const profile = kind === 'vase' ? VASE_PROFILE : DING_PROFILE
  const radialSegments = 32
  const heightSegments = 24
  const radiusMax = obj.size[0] / 2
  const height = obj.size[1]
  const acc = resetTriAccumulator()

  for (let j = 0; j <= heightSegments; j++) {
    const t = j / heightSegments
    const y = t * height - height / 2
    const r = profileRadiusAt(profile, t) * radiusMax
    // 数值法求剖面切线，再旋转得到法线
    const t0 = clamp(t - 0.01, 0, 1)
    const t1 = clamp(t + 0.01, 0, 1)
    const dr = (profileRadiusAt(profile, t1) - profileRadiusAt(profile, t0)) * radiusMax
    const dy = (t1 - t0) * height || 1
    for (let i = 0; i <= radialSegments; i++) {
      const theta = (i / radialSegments) * Math.PI * 2
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      const p: Vec3 = [r * c, y, r * s]
      // 剖面法线：径向分量 dy，竖直分量 -dr
      const n: Vec3 = [dy * c, -dr, dy * s]
      const len = Math.hypot(n[0], n[1], n[2]) || 1
      pushVertex(acc, p, [n[0] / len, n[1] / len, n[2] / len], 0)
    }
  }

  const row = radialSegments + 1
  for (let j = 0; j < heightSegments; j++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = j * row + i
      const b = a + 1
      const c = a + row + 1
      const d = a + row
      acc.indices.push(a, b, c, a, c, d)
    }
  }

  const triangles = finalize(acc)
  const bounds = boundsOf(triangles.positions)

  // 回转面面积：按剖面环带数值积分
  let area = 0
  for (let j = 0; j < heightSegments; j++) {
    const t0 = j / heightSegments
    const t1 = (j + 1) / heightSegments
    const r0 = profileRadiusAt(profile, t0) * radiusMax
    const r1 = profileRadiusAt(profile, t1) * radiusMax
    const slant = Math.hypot(r1 - r0, (t1 - t0) * height)
    area += Math.PI * (r0 + r1) * slant
  }

  const patches: SurfacePatch[] = [
    {
      tag: 'lathe:side',
      areaM2: area,
      // u 方向周长、v 方向高度，chart 比例按此设定
      paramUSize: 2 * Math.PI * radiusMax,
      paramVSize: height,
      doubleSided: false,
    },
  ]

  return {
    objectId: obj.id,
    kind,
    patches,
    triangles,
    localBoundsMin: bounds.min,
    localBoundsMax: bounds.max,
    worldToSurface(worldPos) {
      const inv = mat4.invert(mat4.compose(obj.position, obj.rotationY))
      const local = mat4.transformPoint(inv, worldPos)
      const theta = Math.atan2(local[2], local[0])
      const u = (theta + Math.PI) / (Math.PI * 2)
      const v = clamp((local[1] + height / 2) / height, 0, 1)
      return [u, v]
    },
  }
}
