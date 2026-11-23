import type {
  AtlasReport,
  ChartMeta,
  HallDoc,
  InvalidationEntry,
  InvalidateReason,
  LightConfig,
  SceneObject,
  Vec3,
} from './types'
import { v3 } from './math3d'

export interface SceneSnapshot {
  // 物体 id -> 位置/旋转/尺寸指纹，任何变化都能被检出
  objectFingerprints: Map<string, string>
  lightFingerprints: Map<string, string>
  sceneVersion: number
}

export function takeSnapshot(hall: HallDoc): SceneSnapshot {
  const objectFingerprints = new Map<string, string>()
  for (const obj of hall.objects) {
    objectFingerprints.set(obj.id, fingerprintObject(obj))
  }
  const lightFingerprints = new Map<string, string>()
  for (const light of hall.lights) {
    lightFingerprints.set(light.id, fingerprintLight(light))
  }
  return { objectFingerprints, lightFingerprints, sceneVersion: hall.sceneVersion }
}

function fingerprintObject(obj: SceneObject): string {
  return JSON.stringify({ p: obj.position, r: obj.rotationY, s: obj.size, m: obj.material, k: obj.kind })
}

function fingerprintLight(light: LightConfig): string {
  return JSON.stringify({
    p: light.position,
    t: light.target,
    i: light.intensity,
    b: light.beamAngle,
    c: light.color,
    ies: light.iesProfileId,
    kind: light.kind,
  })
}

// 邻域影响半径（米）：移动物体的弹射光与 AO 影响范围
const NEIGHBOR_RADIUS = 2.5
// 阴影锥外扩角（弧度），防止抖动采样漏判
const SHADOW_MARGIN = 0.08

export interface InvalidationReport {
  entries: InvalidationEntry[]
  affectedChartIds: Set<string>
  affectedRatio: number
  fullBakeRecommended: boolean
  changedObjectIds: string[]
  changedLightIds: string[]
}

// 增量失效分析：输出每个 chart 的失效原因链，绝不静默全量
export function analyzeInvalidation(
  hall: HallDoc,
  atlas: AtlasReport,
  before: SceneSnapshot,
  after: SceneSnapshot,
): InvalidationReport {
  const changedObjectIds: string[] = []
  const changedLightIds: string[] = []
  for (const obj of hall.objects) {
    if (before.objectFingerprints.get(obj.id) !== fingerprintObject(obj)) changedObjectIds.push(obj.id)
  }
  for (const light of hall.lights) {
    if (before.lightFingerprints.get(light.id) !== fingerprintLight(light)) changedLightIds.push(light.id)
  }

  const reasonMap = new Map<string, { reasons: Set<InvalidateReason>; details: string[] }>()
  const addReason = (chart: ChartMeta, reason: InvalidateReason, detail: string): void => {
    const entry = reasonMap.get(chart.id) ?? { reasons: new Set<InvalidateReason>(), details: [] }
    entry.reasons.add(reason)
    entry.details.push(detail)
    reasonMap.set(chart.id, entry)
  }

  const changedObjects = hall.objects.filter((o) => changedObjectIds.includes(o.id))
  const changedLights = hall.lights.filter((l) => changedLightIds.includes(l.id))

  for (const chart of atlas.charts) {
    const chartObj = hall.objects.find((o) => o.id === chart.objectId)
    if (!chartObj) continue

    // 规则 1：自身参数变化，表面 chart 全部失效
    if (changedObjectIds.includes(chart.objectId)) {
      addReason(chart, 'self-moved', `物体 ${chartObj.name} 自身位置/尺寸/材质变化`)
      continue
    }

    // 规则 2：落入移动物体的邻域带，间接光与 AO 受影响
    for (const moved of changedObjects) {
      const d = objectDistance(chartObj, moved)
      if (d <= NEIGHBOR_RADIUS + radiusOf(moved)) {
        addReason(chart, 'neighbor-probe', `邻近物体 ${moved.name} 移动，距离 ${d.toFixed(2)}m 小于影响半径`)
      }
    }

    // 规则 3：落入变化灯光的阴影锥/光锥
    for (const light of changedLights) {
      if (pointInLightFrustum(light, chartObj.position)) {
        addReason(chart, 'light-changed', `灯光 ${light.name} 参数变化且表面在其照射锥内`)
      }
    }

    // 规则 4：移动物体可能在灯光下投出新阴影，检查 chart 表面是否经过移动物体的阴影锥
    for (const light of hall.lights) {
      if (!light.castShadow) continue
      for (const moved of changedObjects) {
        if (shadowPathBlocked(light, moved, chartObj)) {
          addReason(chart, 'shadow-frustum', `物体 ${moved.name} 在 ${light.name} 下对该表面形成阴影变化`)
        }
      }
    }
  }

  const entries: InvalidationEntry[] = [...reasonMap.entries()].map(([chartId, v]) => {
    const chart = atlas.charts.find((c) => c.id === chartId) as ChartMeta
    return {
      chartId,
      objectId: chart.objectId,
      reasons: [...v.reasons],
      detail: v.details.join('；'),
    }
  })

  const affectedChartIds = new Set(entries.map((e) => e.chartId))
  const affectedRatio = atlas.charts.length === 0 ? 0 : affectedChartIds.size / atlas.charts.length
  return {
    entries,
    affectedChartIds,
    affectedRatio,
    // 影响面超过 70% 时增量收益低于调度成本，强制建议全量并要求用户确认
    fullBakeRecommended: affectedRatio > 0.7,
    changedObjectIds,
    changedLightIds,
  }
}

function radiusOf(obj: SceneObject): number {
  return Math.hypot(obj.size[0], obj.size[2]) / 2
}

function objectDistance(a: SceneObject, b: SceneObject): number {
  return v3.length(v3.sub(a.position, b.position))
}

// 点是否在灯光光锥内（射灯/洗墙灯按光束角，其余按距离）
function pointInLightFrustum(light: LightConfig, point: Vec3): boolean {
  const forward = v3.normalize(v3.sub(light.target, light.position))
  const toPoint = v3.sub(point, light.position)
  const dist = v3.length(toPoint)
  if (light.kind === 'skylight') return dist < 12
  if (light.kind === 'linear') return dist < 6
  const dir = v3.scale(toPoint, 1 / dist)
  const cosAngle = v3.dot(forward, dir)
  const halfCos = Math.cos(((light.beamAngle * 1.6 + SHADOW_MARGIN * 180) * Math.PI) / 180)
  return cosAngle >= halfCos && dist < 14
}

// 灯光 -> 移动物体 -> 目标表面是否共线且顺序正确，判定阴影遮挡关系
function shadowPathBlocked(light: LightConfig, moved: SceneObject, target: SceneObject): boolean {
  const fromLightToMoved = v3.sub(moved.position, light.position)
  const fromLightToTarget = v3.sub(target.position, light.position)
  const distMoved = v3.length(fromLightToMoved)
  const distTarget = v3.length(fromLightToTarget)
  if (distMoved >= distTarget) return false
  const dirMoved = v3.scale(fromLightToMoved, 1 / distMoved)
  const dirTarget = v3.scale(fromLightToTarget, 1 / distTarget)
  const alignment = v3.dot(dirMoved, dirTarget)
  // 移动物体有实际体积，对齐阈值随半径放宽
  const threshold = Math.cos(Math.atan2(radiusOf(moved) + 0.3, distMoved))
  return alignment >= threshold
}
