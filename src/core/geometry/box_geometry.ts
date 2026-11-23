import type { ObjectGeometry, SurfacePatch, TriAccumulator } from './parametric_geometry'
import { boundsOf, finalize, pushQuad, resetTriAccumulator } from './parametric_geometry'
import type { SceneObject, Vec3 } from '../types'
import { mat4 } from '../math3d'

// box 六面表面标签，顺序与 surfaceId 一致
const BOX_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const

// 生成墙、吊顶、展柜、展台等 box 类物体
export function buildBoxGeometry(obj: SceneObject): ObjectGeometry {
  const [sx, sy, sz] = obj.size
  const hx = sx / 2
  const hy = sy / 2
  const hz = sz / 2
  const acc = resetTriAccumulator()

  const corners: Record<string, Vec3> = {
    p000: [-hx, -hy, -hz],
    p100: [hx, -hy, -hz],
    p110: [hx, hy, -hz],
    p010: [-hx, hy, -hz],
    p001: [-hx, -hy, hz],
    p101: [hx, -hy, hz],
    p111: [hx, hy, hz],
    p011: [-hx, hy, hz],
  }

  const faceDefs: Array<{ tag: string; corners: [Vec3, Vec3, Vec3, Vec3]; normal: Vec3; area: number }> = [
    { tag: 'px', corners: [corners.p100, corners.p101, corners.p111, corners.p110], normal: [1, 0, 0], area: sy * sz },
    { tag: 'nx', corners: [corners.p001, corners.p000, corners.p010, corners.p011], normal: [-1, 0, 0], area: sy * sz },
    { tag: 'py', corners: [corners.p010, corners.p110, corners.p111, corners.p011], normal: [0, 1, 0], area: sx * sz },
    { tag: 'ny', corners: [corners.p001, corners.p101, corners.p100, corners.p000], normal: [0, -1, 0], area: sx * sz },
    { tag: 'pz', corners: [corners.p101, corners.p001, corners.p011, corners.p111], normal: [0, 0, 1], area: sx * sy },
    { tag: 'nz', corners: [corners.p000, corners.p100, corners.p110, corners.p010], normal: [0, 0, -1], area: sx * sy },
  ]

  const patches: SurfacePatch[] = faceDefs.map((f, i) => ({
    tag: f.tag,
    areaM2: f.area,
    paramUSize: i < 2 ? sz : sx,
    paramVSize: i < 2 ? sy : i < 4 ? sz : sy,
    doubleSided: false,
  }))

  faceDefs.forEach((f, surfaceId) => pushQuad(acc, f.corners[0], f.corners[1], f.corners[2], f.corners[3], f.normal, surfaceId))

  const triangles = finalize(acc)
  const bounds = boundsOf(triangles.positions)

  return {
    objectId: obj.id,
    kind: obj.kind,
    patches,
    triangles,
    localBoundsMin: bounds.min,
    localBoundsMax: bounds.max,
    worldToSurface(worldPos, surfaceId) {
      const inv = mat4.invert(mat4.compose(obj.position, obj.rotationY))
      const local = mat4.transformPoint(inv, worldPos)
      const tag = BOX_FACES[surfaceId]
      // 每个面按局部坐标映射到 0~1，与顶点 uv 规则一致
      if (tag === 'px' || tag === 'nx') return [(local[2] + hz) / sz, (local[1] + hy) / sy]
      if (tag === 'py' || tag === 'ny') return [(local[0] + hx) / sx, (local[2] + hz) / sz]
      return [(local[0] + hx) / sx, (local[1] + hy) / sy]
    },
  }
}
