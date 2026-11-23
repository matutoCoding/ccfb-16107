import type { BuiltSceneGeometry, ObjectGeometry } from './parametric_geometry'
import { buildBoxGeometry } from './box_geometry'
import { buildLatheGeometry } from './lathe_geometry'
import { buildScrollGeometry } from './scroll_geometry'
import type { HallDoc, SceneObject } from '../types'

const BOX_KINDS = new Set(['wall', 'ceiling', 'floor', 'cabinet', 'stand'])

export function buildObjectGeometry(obj: SceneObject): ObjectGeometry {
  if (BOX_KINDS.has(obj.kind)) return buildBoxGeometry(obj)
  if (obj.kind === 'vase' || obj.kind === 'ding') return buildLatheGeometry(obj, obj.kind)
  return buildScrollGeometry(obj)
}

// 整厅几何构建，烘焙与预览共用
export function buildSceneGeometry(hall: HallDoc): BuiltSceneGeometry {
  const geometries = hall.objects.map(buildObjectGeometry)
  const indexById = new Map<string, number>()
  geometries.forEach((g, i) => indexById.set(g.objectId, i))
  return { geometries, indexById }
}
