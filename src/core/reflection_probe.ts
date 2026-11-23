import type { HallDoc, ReflectionProbe, Vec3 } from './types'
import type { BuiltBvh } from './bvh'
import { traceRay } from './bvh'
import { makeLcg, v3 } from './math3d'

// 展柜中心上方自动布点，保证柜内玻璃与展品高光有可采样的环境贴图
export function autoPlaceProbes(hall: HallDoc): ReflectionProbe[] {
  return hall.objects
    .filter((o) => o.kind === 'cabinet')
    .map((cabinet) => ({
      id: `probe_${cabinet.id}`,
      cabinetObjectId: cabinet.id,
      position: [cabinet.position[0], cabinet.position[1] + cabinet.size[1] * 0.4, cabinet.position[2]] as Vec3,
      resolution: 64,
    }))
}

export interface ProbeBakeResult {
  probeId: string
  // 六面顺序：+X -X +Y -Y +Z -Z，每面 resolution*resolution 个 RGB
  faces: Float32Array[]
}

const CUBE_FACES: Array<{ forward: Vec3; up: Vec3 }> = [
  { forward: [1, 0, 0], up: [0, 1, 0] },
  { forward: [-1, 0, 0], up: [0, 1, 0] },
  { forward: [0, 1, 0], up: [0, 0, -1] },
  { forward: [0, -1, 0], up: [0, 0, 1] },
  { forward: [0, 0, 1], up: [0, 1, 0] },
  { forward: [0, 0, -1], up: [0, 1, 0] },
]

// 探针烘焙：每面低采样路径追踪，输出立方体贴图数据
export function bakeProbe(probe: ReflectionProbe, hall: HallDoc, bvh: BuiltBvh, samples = 16): ProbeBakeResult {
  const rng = makeLcg(hashString(probe.id))
  const faces = CUBE_FACES.map((face) => {
    const res = probe.resolution
    const pixels = new Float32Array(res * res * 3)
    const right = v3.normalize(v3.cross(face.forward, face.up))
    const down = v3.scale(face.up, -1)
    for (let py = 0; py < res; py++) {
      for (let px = 0; px < res; px++) {
        const color: Vec3 = [0, 0, 0]
        for (let s = 0; s < samples; s++) {
          const nx = ((px + rng()) / res) * 2 - 1
          const ny = ((py + rng()) / res) * 2 - 1
          const dir = v3.normalize([
            face.forward[0] + right[0] * nx * 0.9 + down[0] * ny * 0.9,
            face.forward[1] + right[1] * nx * 0.9 + down[1] * ny * 0.9,
            face.forward[2] + right[2] * nx * 0.9 + down[2] * ny * 0.9,
          ])
          const hit = traceRay(bvh, probe.position, dir)
          if (!hit) continue
          const obj = hall.objects.find((o) => o.id === hit.objectId)
          const base = obj?.material.baseColor ?? ([0.5, 0.5, 0.5] as Vec3)
          const light = estimateLightAt(hit.point, hit.normal, hall, bvh)
          color[0] += base[0] * light
          color[1] += base[1] * light
          color[2] += base[2] * light
        }
        const idx = (py * res + px) * 3
        pixels[idx] = color[0] / samples
        pixels[idx + 1] = color[1] / samples
        pixels[idx + 2] = color[2] / samples
      }
    }
    return pixels
  })
  return { probeId: probe.id, faces }
}

function estimateLightAt(point: Vec3, normal: Vec3, hall: HallDoc, bvh: BuiltBvh): number {
  let light = 0.12
  for (const l of hall.lights) {
    const to = v3.sub(l.position, point)
    const dist = v3.length(to)
    const dir = v3.scale(to, 1 / dist)
    const ndotl = Math.max(0, v3.dot(normal, dir))
    const blocked = traceRay(bvh, v3.add(point, v3.scale(normal, 0.01)), dir, dist - 0.01)
    if (!blocked) light += (l.intensity * ndotl) / (dist * dist + 0.5)
  }
  return Math.min(1, light)
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h >>> 0
}
