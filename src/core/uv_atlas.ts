import type { AtlasReport, ChartMeta, HallDoc, SceneObject } from './types'
import type { BuiltSceneGeometry } from './geometry/parametric_geometry'

// 重要度权重：展品纹素密度最高，建筑面压低，避免图集被地面吃掉
const IMPORTANCE_WEIGHT: Record<SceneObject['kind'], number> = {
  vase: 4,
  ding: 4,
  scroll: 4,
  cabinet: 2,
  stand: 1.5,
  wall: 1,
  ceiling: 0.75,
  floor: 0.5,
}

interface PlacedRect {
  id: string
  width: number
  height: number
  x: number
  y: number
}

interface FreeRect {
  x: number
  y: number
  width: number
  height: number
}

// MaxRects BSSF 装箱：每次选择浪费最少的自由格放置，再拆分剩余空间
class MaxRectsPacker {
  private freeRects: FreeRect[]
  private used: PlacedRect[] = []

  constructor(private readonly size: number, padding: number) {
    this.freeRects = [{ x: padding, y: padding, width: size - padding * 2, height: size - padding * 2 }]
  }

  private score(rect: FreeRect, w: number, h: number): number {
    const leftover = Math.min(rect.width - w, rect.height - h)
    return leftover < 0 ? Infinity : leftover
  }

  place(id: string, width: number, height: number): PlacedRect | null {
    let best: FreeRect | null = null
    let bestScore = Infinity
    for (const rect of this.freeRects) {
      const s = this.score(rect, width, height)
      if (s < bestScore) {
        bestScore = s
        best = rect
      }
    }
    if (!best) return null
    const placed: PlacedRect = { id, width, height, x: best.x, y: best.y }
    this.used.push(placed)

    // 拆分被占用的自由格
    const next: FreeRect[] = []
    for (const f of this.freeRects) {
      if (
        placed.x >= f.x + f.width ||
        placed.x + placed.width <= f.x ||
        placed.y >= f.y + f.height ||
        placed.y + placed.height <= f.y
      ) {
        next.push(f)
        continue
      }
      if (placed.x > f.x) next.push({ x: f.x, y: f.y, width: placed.x - f.x, height: f.height })
      if (placed.x + placed.width < f.x + f.width) {
        next.push({ x: placed.x + placed.width, y: f.y, width: f.x + f.width - placed.x - placed.width, height: f.height })
      }
      if (placed.y > f.y) next.push({ x: f.x, y: f.y, width: f.width, height: placed.y - f.y })
      if (placed.y + placed.height < f.y + f.height) {
        next.push({ x: f.x, y: placed.y + placed.height, width: f.width, height: f.y + f.height - placed.y - placed.height })
      }
    }
    // 清理被包含的冗余自由格
    this.freeRects = next.filter((a, i) => !next.some((b, j) => i !== j && b.x <= a.x && b.y <= a.y && b.x + b.width >= a.x + a.width && b.y + b.height >= a.y + a.height))
    return placed
  }

  get placed(): PlacedRect[] {
    return this.used
  }
}

export function buildLightmapAtlas(hall: HallDoc, scene: BuiltSceneGeometry): AtlasReport {
  const { atlasSize, baseTexelDensity } = hall.bakeSettings
  // chart 间留 2 纹素间隙，膨胀阶段填充，杜绝采样越界接缝
  const padding = 2
  const packer = new MaxRectsPacker(atlasSize, padding)
  const charts: ChartMeta[] = []

  const candidates = scene.geometries.flatMap((geo) =>
    geo.patches.map((patch) => {
      const obj = hall.objects.find((o) => o.id === geo.objectId) as SceneObject
      const weight = IMPORTANCE_WEIGHT[obj.kind] * obj.importance
      const density = baseTexelDensity * weight
      // 纹素数 = 密度 * 真实长度，最小 8px，比例对齐参数表面避免拉伸
      const widthPx = Math.max(8, Math.round(patch.paramUSize * density))
      const heightPx = Math.max(8, Math.round(patch.paramVSize * density))
      return { geo, patch, weight, density, widthPx, heightPx }
    }),
  )

  // 大 chart 优先，装箱利用率更稳
  candidates.sort((a, b) => b.widthPx * b.heightPx - a.widthPx * a.heightPx)

  for (const item of candidates) {
    const rect = packer.place(`${item.geo.objectId}:${item.patch.tag}`, item.widthPx, item.heightPx)
    if (!rect) {
      throw new Error(`图集 ${atlasSize}px 容量不足，请提高图集尺寸或降低基础纹素密度：${item.geo.objectId}`)
    }
    charts.push({
      id: rect.id,
      objectId: item.geo.objectId,
      surfaceTag: item.patch.tag,
      x: rect.x,
      y: rect.y,
      widthPx: rect.width,
      heightPx: rect.height,
      areaM2: item.patch.areaM2,
      texelDensity: item.density,
      importanceWeight: item.weight,
    })
  }

  const usedPx = charts.reduce((sum, c) => sum + c.widthPx * c.heightPx, 0)
  const totalPx = atlasSize * atlasSize
  return {
    size: atlasSize,
    charts,
    utilization: usedPx / totalPx,
    wastedPx: totalPx - usedPx,
  }
}
