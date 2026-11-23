import type {
  AtlasReport,
  BakeChannelName,
  BakeRecord,
  ChartMeta,
  HallDoc,
  IesProfile,
  InvalidationEntry,
} from './types'
import type { BuiltBvh } from './bvh'
import type { BuiltSceneGeometry } from './geometry/parametric_geometry'
import { CpuPathTracer, type ChartBakeOutput } from './path_tracer'
import { denoiseAtlas, dilateAtlas } from './dilate_denoise'

export interface BakeProgress {
  phase: 'prepare' | 'tracing' | 'dilate' | 'denoise' | 'finalize'
  finishedCharts: number
  totalCharts: number
  currentChartId: string | null
  chartProgress: number
  // 0~1 总进度
  overall: number
  elapsedMs: number
}

export interface BakeSchedulerOptions {
  hall: HallDoc
  atlas: AtlasReport
  bvh: BuiltBvh
  scene: BuiltSceneGeometry
  iesById: Map<string, IesProfile>
  // 增量模式下只烘焙这些 chart；全量模式传 null
  targetChartIds: Set<string> | null
  invalidations: InvalidationEntry[]
  // 增量模式传入旧图集纹理，烘焙结果就地覆盖
  existingChannels?: Record<BakeChannelName, Float32Array>
  onProgress: (p: BakeProgress) => void
  isCancelled: () => boolean
}

export interface BakeSchedulerResult {
  channels: Record<BakeChannelName, Float32Array>
  // 降噪/膨胀前的原始通道，检查页用于降噪前后对比
  rawChannels: Record<BakeChannelName, Float32Array>
  outputs: ChartBakeOutput[]
  record: Omit<BakeRecord, 'id' | 'meanError' | 'rmse' | 'psnr'>
}

// 把单 chart 像素写回图集对应矩形
function mergeChartIntoAtlas(
  channels: Record<BakeChannelName, Float32Array>,
  output: ChartBakeOutput,
  chart: ChartMeta,
  atlasSize: number,
): void {
  for (let y = 0; y < output.height; y++) {
    for (let x = 0; x < output.width; x++) {
      const srcIdx = (y * output.width + x) * 3
      const dstIdx = ((chart.y + y) * atlasSize + chart.x + x) * 3
      for (const key of ['direct', 'indirect', 'ao'] as const) {
        channels[key][dstIdx] = output.pixels[key][srcIdx]
        channels[key][dstIdx + 1] = output.pixels[key][srcIdx + 1]
        channels[key][dstIdx + 2] = output.pixels[key][srcIdx + 2]
      }
    }
  }
}

function emptyChannels(size: number): Record<BakeChannelName, Float32Array> {
  return {
    direct: new Float32Array(size * size * 3),
    indirect: new Float32Array(size * size * 3),
    ao: new Float32Array(size * size * 3),
  }
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export async function runBakeScheduler(options: BakeSchedulerOptions): Promise<BakeSchedulerResult | null> {
  const { hall, atlas, bvh, scene, iesById, targetChartIds, invalidations, existingChannels, onProgress, isCancelled } = options
  const startedAt = Date.now()
  const size = atlas.size
  const channels = existingChannels
    ? { direct: existingChannels.direct.slice(), indirect: existingChannels.indirect.slice(), ao: existingChannels.ao.slice() }
    : emptyChannels(size)

  const targets = targetChartIds === null
    ? atlas.charts
    : atlas.charts.filter((c) => targetChartIds.has(c.id))
  const tracer = new CpuPathTracer({ hall, bvh, scene, iesById })
  const outputs: ChartBakeOutput[] = []
  const chunkSize = Math.max(1, hall.bakeSettings.chunkSize)

  onProgress({
    phase: 'prepare',
    finishedCharts: 0,
    totalCharts: targets.length,
    currentChartId: null,
    chartProgress: 0,
    overall: 0,
    elapsedMs: 0,
  })
  await yieldToUi()

  for (let i = 0; i < targets.length; i++) {
    if (isCancelled()) return null
    const chart = targets[i]
    const output = tracer.bakeChart(chart, (chartProgress) => {
      onProgress({
        phase: 'tracing',
        finishedCharts: i,
        totalCharts: targets.length,
        currentChartId: chart.id,
        chartProgress,
        overall: (i + chartProgress) / targets.length,
        elapsedMs: Date.now() - startedAt,
      })
    })
    outputs.push(output)
    mergeChartIntoAtlas(channels, output, chart, size)

    // 每个时间片结束让出主线程，保证界面与取消按钮响应
    if ((i + 1) % chunkSize === 0 || i === targets.length - 1) {
      await yieldToUi()
    }
  }

  if (isCancelled()) return null

  // 膨胀只跑受影响 chart 的外扩区域，这里整体跑一遍 O(n) 可接受；增量时旧区域幂等
  onProgress({ phase: 'dilate', finishedCharts: targets.length, totalCharts: targets.length, currentChartId: null, chartProgress: 1, overall: 0.92, elapsedMs: Date.now() - startedAt })
  dilateAtlas(channels, size, hall.bakeSettings.dilationRadius)
  await yieldToUi()

  let denoised = false
  // 保留膨胀后、降噪前的快照，供检查页做降噪前后对比
  const rawChannels: Record<BakeChannelName, Float32Array> = {
    direct: channels.direct.slice(),
    indirect: channels.indirect.slice(),
    ao: channels.ao.slice(),
  }
  if (hall.bakeSettings.denoise) {
    if (isCancelled()) return null
    onProgress({ phase: 'denoise', finishedCharts: targets.length, totalCharts: targets.length, currentChartId: null, chartProgress: 1, overall: 0.96, elapsedMs: Date.now() - startedAt })
    // G-buffer 由烘焙场景即时生成，物体 id 用 chart 索引映射
    const gbuffer = buildGbufferProxy(atlas, size)
    const denoisedChannels = denoiseAtlas(channels, gbuffer, size)
    channels.direct.set(denoisedChannels.direct)
    channels.indirect.set(denoisedChannels.indirect)
    denoised = true
    await yieldToUi()
  }

  onProgress({ phase: 'finalize', finishedCharts: targets.length, totalCharts: targets.length, currentChartId: null, chartProgress: 1, overall: 1, elapsedMs: Date.now() - startedAt })
  const finishedAt = Date.now()

  return {
    channels,
    rawChannels,
    outputs,
    record: {
      hallId: hall.id,
      sceneVersion: hall.sceneVersion,
      atlasSize: size,
      channels: ['direct', 'indirect', 'ao'],
      startedAt,
      finishedAt,
      elapsedMs: finishedAt - startedAt,
      sampleCount: hall.bakeSettings.samplesPerPixel,
      bounceCount: hall.bakeSettings.bounceCount,
      incremental: targetChartIds !== null,
      invalidations,
      denoised,
    },
  }
}

// 降噪 G-buffer 代理：图集纹素按所在 chart 归属物体，法线差异由亮度权重兜底
function buildGbufferProxy(atlas: AtlasReport, size: number): { normals: Float32Array; objectIds: Int32Array } {
  const normals = new Float32Array(size * size * 3)
  const objectIds = new Int32Array(size * size).fill(-1)
  atlas.charts.forEach((chart, chartIndex) => {
    for (let y = chart.y; y < chart.y + chart.heightPx; y++) {
      for (let x = chart.x; x < chart.x + chart.widthPx; x++) {
        const idx = y * size + x
        objectIds[idx] = chartIndex
        normals[idx * 3 + 1] = 1
      }
    }
  })
  return { normals, objectIds }
}
