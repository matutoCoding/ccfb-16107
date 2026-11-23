import type { AtlasReport, ChartMeta, HallDoc, Vec3 } from './types'
import { composeChannels, heatColor } from './texture_utils'
import type { BakeChannelName } from './types'
import { v3 } from './math3d'

export interface ErrorMetrics {
  // 平均绝对误差（归一化 0~1），对应主人要求的 2% 门槛
  meanError: number
  rmse: number
  psnr: number
  maxError: number
  errorMap: Float32Array
  // 超阈值纹素占比
  overThresholdRatio: number
}

// 逐像素误差图：烘焙图集 vs 参考路径追踪帧，按 chart 对齐后比较
export function computeErrorMap(
  baked: Record<BakeChannelName, Float32Array>,
  reference: Float32Array,
  atlas: AtlasReport,
): ErrorMetrics {
  const size = atlas.size
  const bakedComposed = composeChannels(baked, size * size)
  const errorMap = new Float32Array(size * size * 3)
  let sumAbs = 0
  let sumSq = 0
  let maxError = 0
  let counted = 0
  let overThreshold = 0
  const THRESHOLD = 0.05

  for (let i = 0; i < size * size; i++) {
    const inChart = atlas.charts.some((c) => isInsideChart(c, i % size, Math.floor(i / size), size))
    if (!inChart) continue
    const dr = bakedComposed[i * 3] - reference[i * 3]
    const dg = bakedComposed[i * 3 + 1] - reference[i * 3 + 1]
    const db = bakedComposed[i * 3 + 2] - reference[i * 3 + 2]
    const absError = (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 3
    const sqError = (dr * dr + dg * dg + db * db) / 3
    sumAbs += absError
    sumSq += sqError
    maxError = Math.max(maxError, absError)
    overThreshold += absError > THRESHOLD ? 1 : 0
    counted++
    const heat = heatColor(Math.min(1, absError * 4))
    errorMap[i * 3] = heat[0]
    errorMap[i * 3 + 1] = heat[1]
    errorMap[i * 3 + 2] = heat[2]
  }

  const meanError = counted === 0 ? 0 : sumAbs / counted
  const mse = counted === 0 ? 0 : sumSq / counted
  const rmse = Math.sqrt(mse)
  const psnr = mse <= 1e-10 ? 99 : 10 * Math.log10(1 / mse)
  return {
    meanError,
    rmse,
    psnr,
    maxError,
    errorMap,
    overThresholdRatio: counted === 0 ? 0 : overThreshold / counted,
  }
}

function isInsideChart(chart: ChartMeta, x: number, y: number, _size: number): boolean {
  return x >= chart.x && x < chart.x + chart.widthPx && y >= chart.y && y < chart.y + chart.heightPx
}

export interface LeakFinding {
  chartId: string
  objectId: string
  x: number
  y: number
  kind: 'light-leak' | 'shadow-misalignment'
  severity: number
  description: string
}

// 漏光：AO 低（被包围）但直接光高，物理上矛盾
// 阴影错位：直接光在相邻纹素间梯度突变且超出几何边界梯度
export function detectLightLeak(
  channels: Record<BakeChannelName, Float32Array>,
  atlas: AtlasReport,
): LeakFinding[] {
  const findings: LeakFinding[] = []
  const size = atlas.size
  for (const chart of atlas.charts) {
    for (let y = chart.y + 1; y < chart.y + chart.heightPx - 1; y++) {
      for (let x = chart.x + 1; x < chart.x + chart.widthPx - 1; x++) {
        const idx = y * size + x
        const ao = channels.ao[idx * 3]
        const direct = lum(channels.direct, idx)
        if (ao < 0.25 && direct > 0.6) {
          findings.push({
            chartId: chart.id,
            objectId: chart.objectId,
            x,
            y,
            kind: 'light-leak',
            severity: direct * (1 - ao),
            description: `封闭区域出现高直接光（AO=${ao.toFixed(2)}，亮度=${direct.toFixed(2)}）`,
          })
        }
        const neighborLum = lum(channels.direct, idx - 1)
        const gradient = Math.abs(direct - neighborLum)
        if (gradient > 0.45) {
          findings.push({
            chartId: chart.id,
            objectId: chart.objectId,
            x,
            y,
            kind: 'shadow-misalignment',
            severity: gradient,
            description: `直接光相邻纹素突变 ${gradient.toFixed(2)}，疑似阴影错位`,
          })
        }
      }
    }
  }
  // 同位置只保留最严重的一条，避免标注淹没模型
  findings.sort((a, b) => b.severity - a.severity)
  return dedupeGrid(findings, size, 8).slice(0, 64)
}

function lum(channel: Float32Array, idx: number): number {
  return channel[idx * 3] * 0.2126 + channel[idx * 3 + 1] * 0.7152 + channel[idx * 3 + 2] * 0.0722
}

function dedupeGrid(findings: LeakFinding[], size: number, cell: number): LeakFinding[] {
  const seen = new Set<string>()
  const out: LeakFinding[] = []
  for (const f of findings) {
    const key = `${f.kind}:${Math.floor(f.x / cell)}:${Math.floor(f.y / cell)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  void size
  return out
}

// 接缝连续性：扫描 chart 边界外侧膨胀纹素，色差超过门槛即定位
export interface SeamFinding {
  chartId: string
  x: number
  y: number
  deltaE: number
}

export function detectSeamDiscontinuity(
  channels: Record<BakeChannelName, Float32Array>,
  atlas: AtlasReport,
): SeamFinding[] {
  const size = atlas.size
  const composed = composeChannels(channels, size * size)
  const findings: SeamFinding[] = []
  for (const chart of atlas.charts) {
    const check = (x: number, y: number, nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) return
      const a: Vec3 = [composed[(y * size + x) * 3], composed[(y * size + x) * 3 + 1], composed[(y * size + x) * 3 + 2]]
      const b: Vec3 = [composed[(ny * size + nx) * 3], composed[(ny * size + nx) * 3 + 1], composed[(ny * size + nx) * 3 + 2]]
      const deltaE = v3.length(v3.sub(a, b))
      // 2.3 约对应 sRGB 可感知色差门槛
      if (deltaE > 2.3 / 255) {
        findings.push({ chartId: chart.id, x, y, deltaE })
      }
    }
    for (let x = chart.x; x < chart.x + chart.widthPx; x++) {
      check(x, chart.y, x, chart.y - 1)
      check(x, chart.y + chart.heightPx - 1, x, chart.y + chart.heightPx)
    }
  }
  findings.sort((a, b) => b.deltaE - a.deltaE)
  return findings.slice(0, 32)
}

// 纹素密度热力图：按 chart 实际密度映射，暴露密度失衡的表面
export function buildDensityHeatmap(atlas: AtlasReport): { image: Float32Array; minDensity: number; maxDensity: number } {
  const size = atlas.size
  const image = new Float32Array(size * size * 3)
  const densities = atlas.charts.map((c) => c.texelDensity)
  const minDensity = Math.min(...densities, 1)
  const maxDensity = Math.max(...densities, minDensity + 1)
  for (const chart of atlas.charts) {
    const t = (chart.texelDensity - minDensity) / (maxDensity - minDensity)
    const color = heatColor(t)
    for (let y = chart.y; y < chart.y + chart.heightPx; y++) {
      for (let x = chart.x; x < chart.x + chart.widthPx; x++) {
        const idx = (y * size + x) * 3
        image[idx] = color[0]
        image[idx + 1] = color[1]
        image[idx + 2] = color[2]
      }
    }
  }
  return { image, minDensity, maxDensity }
}

// 验收门槛汇总，给发布页一个 go/no-go 结论
export interface QualityVerdict {
  passed: boolean
  meanError: number
  seamFailCount: number
  leakFailCount: number
  notes: string[]
}

export function evaluateQuality(hall: HallDoc, metrics: ErrorMetrics, seams: SeamFinding[], leaks: LeakFinding[]): QualityVerdict {
  const notes: string[] = []
  const errorPass = metrics.meanError < 0.02
  const seamPass = seams.length === 0
  const leakPass = leaks.filter((l) => l.kind === 'light-leak').length === 0
  if (!errorPass) notes.push(`平均误差 ${(metrics.meanError * 100).toFixed(2)}% 超过 2% 门槛`)
  if (!seamPass) notes.push(`存在 ${seams.length} 处可见接缝色差`)
  if (!leakPass) notes.push(`存在 ${leaks.filter((l) => l.kind === 'light-leak').length} 处漏光`)
  if (notes.length === 0) notes.push('全部验收指标通过')
  void hall
  return { passed: errorPass && seamPass && leakPass, meanError: metrics.meanError, seamFailCount: seams.length, leakFailCount: leaks.length, notes }
}
