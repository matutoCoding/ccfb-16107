import type { ObjectGeometry, SurfacePatch, TriAccumulator } from './parametric_geometry'
import { boundsOf, finalize, pushQuad, resetTriAccumulator } from './parametric_geometry'
import type { SceneObject, Vec3 } from '../types'
import { mat4 } from '../math3d'

// 书画卷轴：正面画面是独立平面 chart，背面和卷轴棒不参与烘焙
export function buildScrollGeometry(obj: SceneObject): ObjectGeometry {
  const [w, h] = obj.size
  const hx = w / 2
  const hy = h / 2
  const z = 0
  const acc = resetTriAccumulator()

  const p0: Vec3 = [-hx, -hy, z]
  const p1: Vec3 = [hx, -hy, z]
  const p2: Vec3 = [hx, hy, z]
  const p3: Vec3 = [-hx, hy, z]
  // 画面默认朝 +Z，布展时旋转贴墙
  pushQuad(acc, p0, p1, p2, p3, [0, 0, 1], 0)

  const triangles = finalize(acc)
  const bounds = boundsOf(triangles.positions)
  const patches: SurfacePatch[] = [
    {
      tag: 'scroll:face',
      areaM2: w * h,
      paramUSize: w,
      paramVSize: h,
      // 画面双面可见，背面采样时翻转 u
      doubleSided: true,
    },
  ]

  return {
    objectId: obj.id,
    kind: 'scroll',
    patches,
    triangles,
    localBoundsMin: bounds.min,
    localBoundsMax: bounds.max,
    worldToSurface(worldPos, _surfaceId, model) {
      const inv = mat4.invert(model)
      const local = mat4.transformPoint(inv, worldPos)
      return [(local[0] + hx) / w, (local[1] + hy) / h]
    },
  }
}
