import type { ObjectKind, SceneObject, Vec3 } from '../types'
import { mat4, type Mat4 } from '../math3d'

// 物体表面：box 的六个面、cylinder 的侧/顶盖、lathe 的回转面
export interface SurfacePatch {
  tag: string
  areaM2: number
  // 参数空间尺寸，chart 像素宽高比与之对齐，避免纹素密度被拉伸
  paramUSize: number
  paramVSize: number
  doubleSided: boolean
}

export interface TriData {
  positions: Float32Array // 物体局部空间
  normals: Float32Array
  indices: Uint32Array
  // 每个顶点对应的表面标签 id（patch 在 patches 中的下标）
  surfaceIds: Uint16Array
}

export interface ObjectGeometry {
  objectId: string
  kind: ObjectKind
  patches: SurfacePatch[]
  triangles: TriData
  localBoundsMin: Vec3
  localBoundsMax: Vec3
  // 局部位置 -> 表面参数 (u, v)，烘焙采样时反查 chart 坐标
  worldToSurface: (worldPos: Vec3, surfaceId: number, model: Mat4) => [number, number]
}

export interface BuiltSceneGeometry {
  geometries: ObjectGeometry[]
  // 物体 id -> 几何下标
  indexById: Map<string, number>
}

export function objectModel(obj: SceneObject): Mat4 {
  return mat4.compose(obj.position, obj.rotationY)
}

// 每个三角面片的顶点携带表面 id，写入独立顶点属性
export interface TriAccumulator {
  positions: number[]
  normals: number[]
  surfaceIds: number[]
  indices: number[]
  vertexCount: number
}

const tri: TriAccumulator = {
  positions: [],
  normals: [],
  surfaceIds: [],
  indices: [],
  vertexCount: 0,
}

export function resetTriAccumulator(): TriAccumulator {
  tri.positions.length = 0
  tri.normals.length = 0
  tri.surfaceIds.length = 0
  tri.indices.length = 0
  tri.vertexCount = 0
  return tri
}

function pushVertex(acc: TriAccumulator, p: Vec3, n: Vec3, surfaceId: number): void {
  acc.positions.push(p[0], p[1], p[2])
  acc.normals.push(n[0], n[1], n[2])
  acc.surfaceIds.push(surfaceId)
}

function pushQuad(
  acc: TriAccumulator,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  normal: Vec3,
  surfaceId: number,
): void {
  const base = acc.vertexCount
  pushVertex(acc, a, normal, surfaceId)
  pushVertex(acc, b, normal, surfaceId)
  pushVertex(acc, c, normal, surfaceId)
  pushVertex(acc, d, normal, surfaceId)
  acc.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  acc.vertexCount += 4
}

function finalize(acc: TriAccumulator): TriData {
  return {
    positions: new Float32Array(acc.positions),
    normals: new Float32Array(acc.normals),
    indices: new Uint32Array(acc.indices),
    surfaceIds: new Uint16Array(acc.surfaceIds),
  }
}

function boundsOf(positions: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k])
      max[k] = Math.max(max[k], positions[i + k])
    }
  }
  return { min, max }
}

export { pushQuad, finalize, boundsOf, tri as sharedAccumulator }
