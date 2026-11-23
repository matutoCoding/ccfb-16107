import type { Vec3 } from './types'
import type { BuiltSceneGeometry } from './geometry/parametric_geometry'
import { objectModel } from './geometry/parametric_geometry'
import { mat4 } from './math3d'

// 扁平 BVH 节点：叶子 firstTri >= 0，内部节点 firstTri = -1
export interface BvhNode {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
  left: number
  right: number
  firstTri: number
  triCount: number
}

export interface TriangleRecord {
  // 世界空间顶点
  v0: Vec3
  v1: Vec3
  v2: Vec3
  n0: Vec3
  n1: Vec3
  n2: Vec3
  objectId: string
  surfaceId: number
}

export interface BuiltBvh {
  nodes: BvhNode[]
  triangles: TriangleRecord[]
}

const MAX_LEAF_TRIS = 4

interface TriWithBounds {
  index: number
  center: Vec3
  min: Vec3
  max: Vec3
}

function triBounds(t: TriangleRecord): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const v of [t.v0, t.v1, t.v2]) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[k])
      max[k] = Math.max(max[k], v[k])
    }
  }
  return { min, max }
}

function mergeBounds(list: TriWithBounds[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const item of list) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], item.min[k])
      max[k] = Math.max(max[k], item.max[k])
    }
  }
  return { min, max }
}

export function buildBvh(scene: BuiltSceneGeometry, hallObjects: { id: string; position: Vec3; rotationY: number }[]): BuiltBvh {
  const modelById = new Map(hallObjects.map((o) => [o.id, objectModel(o as never)]))
  const triangles: TriangleRecord[] = []

  scene.geometries.forEach((geo) => {
    const model = modelById.get(geo.objectId) ?? mat4.identity()
    const data = geo.triangles
    for (let i = 0; i < data.indices.length; i += 3) {
      const ia = data.indices[i] * 3
      const ib = data.indices[i + 1] * 3
      const ic = data.indices[i + 2] * 3
      const readV = (base: number): Vec3 => [data.positions[base], data.positions[base + 1], data.positions[base + 2]]
      const readN = (base: number): Vec3 => [data.normals[base], data.normals[base + 1], data.normals[base + 2]]
      triangles.push({
        v0: mat4.transformPoint(model, readV(ia)),
        v1: mat4.transformPoint(model, readV(ib)),
        v2: mat4.transformPoint(model, readV(ic)),
        n0: mat4.transformDir(model, readN(ia)),
        n1: mat4.transformDir(model, readN(ib)),
        n2: mat4.transformDir(model, readN(ic)),
        objectId: geo.objectId,
        surfaceId: data.surfaceIds[ia / 3],
      })
    }
  })

  const items: TriWithBounds[] = triangles.map((t, index) => {
    const b = triBounds(t)
    return {
      index,
      min: b.min,
      max: b.max,
      center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
    }
  })

  const nodes: BvhNode[] = []

  const makeNode = (bounds: { min: Vec3; max: Vec3 }, common: Partial<BvhNode>): number => {
    nodes.push({
      minX: bounds.min[0],
      minY: bounds.min[1],
      minZ: bounds.min[2],
      maxX: bounds.max[0],
      maxY: bounds.max[1],
      maxZ: bounds.max[2],
      left: -1,
      right: -1,
      firstTri: -1,
      triCount: 0,
      ...common,
    })
    return nodes.length - 1
  }

  const buildRecursive = (list: TriWithBounds[]): number => {
    const bounds = mergeBounds(list)
    if (list.length <= MAX_LEAF_TRIS) {
      return makeNode(bounds, { firstTri: list[0].index, triCount: list.length })
    }
    const extents: Vec3 = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ]
    const axis = extents[0] >= extents[1] && extents[0] >= extents[2] ? 0 : extents[1] >= extents[2] ? 1 : 2
    const sorted = [...list].sort((a, b) => a.center[axis] - b.center[axis])
    const mid = Math.floor(sorted.length / 2)
    const leftList = sorted.slice(0, mid)
    const rightList = sorted.slice(mid)
    const nodeId = makeNode(bounds, {})
    const leftId = buildRecursive(leftList)
    const rightId = buildRecursive(rightList)
    nodes[nodeId].left = leftId
    nodes[nodeId].right = rightId
    return nodeId
  }

  if (items.length > 0) buildRecursive(items)
  return { nodes, triangles }
}

export interface RayHit {
  t: number
  triangleIndex: number
  point: Vec3
  normal: Vec3
  objectId: string
  surfaceId: number
}

// Moller-Trumbore 求交
export function intersectTriangle(
  origin: Vec3,
  dir: Vec3,
  tri: TriangleRecord,
  tMax: number,
): number | null {
  const edge1 = [tri.v1[0] - tri.v0[0], tri.v1[1] - tri.v0[1], tri.v1[2] - tri.v0[2]]
  const edge2 = [tri.v2[0] - tri.v0[0], tri.v2[1] - tri.v0[1], tri.v2[2] - tri.v0[2]]
  const h = [
    dir[1] * edge2[2] - dir[2] * edge2[1],
    dir[2] * edge2[0] - dir[0] * edge2[2],
    dir[0] * edge2[1] - dir[1] * edge2[0],
  ]
  const a = edge1[0] * h[0] + edge1[1] * h[1] + edge1[2] * h[2]
  if (Math.abs(a) < 1e-8) return null
  const f = 1 / a
  const s = [origin[0] - tri.v0[0], origin[1] - tri.v0[1], origin[2] - tri.v0[2]]
  const u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2])
  if (u < 0 || u > 1) return null
  const q = [
    s[1] * edge1[2] - s[2] * edge1[1],
    s[2] * edge1[0] - s[0] * edge1[2],
    s[0] * edge1[1] - s[1] * edge1[0],
  ]
  const v = f * (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2])
  if (v < 0 || u + v > 1) return null
  const t = f * (edge2[0] * q[0] + edge2[1] * q[1] + edge2[2] * q[2])
  if (t <= 1e-4 || t >= tMax) return null
  return t
}

function hitAabb(origin: Vec3, dir: Vec3, invDir: Vec3, node: BvhNode): number {
  let tmin = 0
  let tmax = Infinity
  const min = [node.minX, node.minY, node.minZ]
  const max = [node.maxX, node.maxY, node.maxZ]
  for (let k = 0; k < 3; k++) {
    let t1 = (min[k] - origin[k]) * invDir[k]
    let t2 = (max[k] - origin[k]) * invDir[k]
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmax <= tmin) return Infinity
  }
  return tmin
}

// CPU 侧射线查询：参考图渲染、探针烘焙和单测共用
export function traceRay(bvh: BuiltBvh, origin: Vec3, dir: Vec3, tMax = Infinity): RayHit | null {
  if (bvh.nodes.length === 0) return null
  const invDir: Vec3 = [1 / (dir[0] || 1e-9), 1 / (dir[1] || 1e-9), 1 / (dir[2] || 1e-9)]
  const stack: number[] = [0]
  let closest = tMax
  let hit: RayHit | null = null

  while (stack.length > 0) {
    const nodeId = stack.pop() as number
    const node = bvh.nodes[nodeId]
    if (hitAabb(origin, dir, invDir, node) >= closest) continue
    if (node.firstTri >= 0) {
      for (let i = 0; i < node.triCount; i++) {
        const triIndex = node.firstTri + i
        const t = intersectTriangle(origin, dir, bvh.triangles[triIndex], closest)
        if (t === null) continue
        closest = t
        const tri = bvh.triangles[triIndex]
        hit = {
          t,
          triangleIndex: triIndex,
          point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
          normal: tri.n0,
          objectId: tri.objectId,
          surfaceId: tri.surfaceId,
        }
      }
    } else {
      stack.push(node.left, node.right)
    }
  }
  return hit
}
