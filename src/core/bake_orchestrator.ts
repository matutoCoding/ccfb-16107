import type {
  BakeChannelName,
  BakeRecord,
  ChartMeta,
  HallDoc,
  IesProfile,
} from './types'
import { buildSceneGeometry } from './geometry/geometry_builder'
import { buildBvh } from './bvh'
import { buildLightmapAtlas } from './uv_atlas'
import { runBakeScheduler, type BakeProgress, type BakeSchedulerResult } from './bake_scheduler'
import { analyzeInvalidation, takeSnapshot, type InvalidationReport } from './incremental_bake'
import { channelToImageData, imageDataToBlob } from './texture_utils'
import { denoiseAtlas, dilateAtlas } from './dilate_denoise'
import { hallRepository, type StoredTexture } from './storage/hall_repository'
import { decodeTextureChannels } from './storage/texture_codec'
import type { WebGpuComputeBaker } from './renderer/webgpu_compute_baker'

export interface BakeRunOptions {
  hall: HallDoc
  forceFull: boolean
  gpuBaker: WebGpuComputeBaker | null
  iesById: Map<string, IesProfile>
  onProgress: (p: BakeProgress) => void
  isCancelled: () => boolean
}

export interface BakeRunOutcome {
  record: BakeRecord
  report: InvalidationReport | null
  backend: 'webgpu' | 'cpu'
}

// 烘焙编排：构建几何/BVH/图集 -> 增量判定 -> 调度 -> 纹理入库
export async function executeBake(options: BakeRunOptions): Promise<BakeRunOutcome> {
  const { hall, forceFull, gpuBaker, iesById, onProgress, isCancelled } = options
  const scene = buildSceneGeometry(hall)
  const bvh = buildBvh(scene, hall.objects)
  const atlas = buildLightmapAtlas(hall, scene)

  const previousSnapshot = await hallRepository.getSnapshot(hall.id)
  const currentSnapshot = takeSnapshot(hall)
  let report: InvalidationReport | null = null
  let targetChartIds: Set<string> | null = null
  let existingChannels: Record<BakeChannelName, Float32Array> | undefined

  if (!forceFull && previousSnapshot && hall.lastBakeId) {
    report = analyzeInvalidation(hall, atlas, previousSnapshot, currentSnapshot)
    if (report.affectedChartIds.size > 0 && !report.fullBakeRecommended) {
      targetChartIds = report.affectedChartIds
      const previous = await hallRepository.getBake(hall.lastBakeId)
      if (previous) existingChannels = await decodeTextureChannels(previous.texture, atlas.size)
    }
    // 影响面过大或无受影响块时 targetChartIds 保持 null，由调度器走全量
  }
  const invalidations = report?.entries ?? []

  let result: BakeSchedulerResult | null = null
  let backend: 'webgpu' | 'cpu' = 'cpu'

  // WebGPU 后端优先：逐 chart dispatch，失败自动回落 CPU 调度器
  if (gpuBaker) {
    const gpuResult = await runGpuBake({
      hall,
      scene,
      bvh,
      atlas,
      targetChartIds,
      gpuBaker,
      iesById,
      onProgress,
      isCancelled,
      existingChannels,
    })
    if (gpuResult) {
      result = gpuResult
      backend = 'webgpu'
    }
  }
  if (!result) {
    result = await runBakeScheduler({
      hall,
      atlas,
      bvh,
      scene,
      iesById,
      targetChartIds,
      invalidations,
      existingChannels,
      onProgress,
      isCancelled,
    })
  }
  if (!result) throw new Error('烘焙已取消')

  const record = await persistBakeResult(hall, atlas, result, report)
  await hallRepository.saveSnapshot(hall.id, currentSnapshot)
  hall.lastBakeId = record.id
  await hallRepository.save(hall)
  return { record, report, backend }
}

async function runGpuBake(args: {
  hall: HallDoc
  scene: ReturnType<typeof buildSceneGeometry>
  bvh: ReturnType<typeof buildBvh>
  atlas: ReturnType<typeof buildLightmapAtlas>
  targetChartIds: Set<string> | null
  gpuBaker: WebGpuComputeBaker
  iesById: Map<string, IesProfile>
  onProgress: (p: BakeProgress) => void
  isCancelled: () => boolean
  existingChannels?: Record<BakeChannelName, Float32Array>
}): Promise<BakeSchedulerResult | null> {
  const { hall, scene, bvh, atlas, targetChartIds, gpuBaker, iesById, onProgress, isCancelled, existingChannels } = args
  const size = atlas.size
  const channels = existingChannels
    ? { direct: existingChannels.direct.slice(), indirect: existingChannels.indirect.slice(), ao: existingChannels.ao.slice() }
    : { direct: new Float32Array(size * size * 3), indirect: new Float32Array(size * size * 3), ao: new Float32Array(size * size * 3) }
  const targets = targetChartIds === null ? atlas.charts : atlas.charts.filter((c) => targetChartIds.has(c.id))
  const startedAt = Date.now()

  for (let i = 0; i < targets.length; i++) {
    if (isCancelled()) return null
    const chart = targets[i]
    onProgress({ phase: 'tracing', finishedCharts: i, totalCharts: targets.length, currentChartId: chart.id, chartProgress: 0.5, overall: (i + 0.5) / targets.length, elapsedMs: Date.now() - startedAt })
    const gpuChannels = await gpuBaker.bakeChart(hall, scene, bvh, chart, iesById)
    if (!gpuChannels) return null
    copyChartRegion(gpuChannels, channels, chart, size)
    // 每个 chart 后让出事件循环，界面不卡死
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  if (isCancelled()) return null
  // 与 CPU 调度器保持一致的后处理：膨胀防缝 + G-buffer 引导降噪
  onProgress({ phase: 'dilate', finishedCharts: targets.length, totalCharts: targets.length, currentChartId: null, chartProgress: 1, overall: 0.92, elapsedMs: Date.now() - startedAt })
  dilateAtlas(channels, size, hall.bakeSettings.dilationRadius)
  const rawChannels: Record<BakeChannelName, Float32Array> = {
    direct: channels.direct.slice(),
    indirect: channels.indirect.slice(),
    ao: channels.ao.slice(),
  }
  let denoised = false
  if (hall.bakeSettings.denoise) {
    if (isCancelled()) return null
    onProgress({ phase: 'denoise', finishedCharts: targets.length, totalCharts: targets.length, currentChartId: null, chartProgress: 1, overall: 0.96, elapsedMs: Date.now() - startedAt })
    const gbuffer = buildGbufferProxy(atlas, size)
    const denoisedChannels = denoiseAtlas(channels, gbuffer, size)
    channels.direct.set(denoisedChannels.direct)
    channels.indirect.set(denoisedChannels.indirect)
    denoised = true
  }

  return {
    channels,
    rawChannels,
    outputs: [],
    record: {
      hallId: hall.id,
      sceneVersion: hall.sceneVersion,
      atlasSize: size,
      channels: ['direct', 'indirect', 'ao'],
      startedAt,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      sampleCount: hall.bakeSettings.samplesPerPixel,
      bounceCount: hall.bakeSettings.bounceCount,
      incremental: targetChartIds !== null,
      invalidations: [],
      denoised,
    },
  }
}

function buildGbufferProxy(atlas: ReturnType<typeof buildLightmapAtlas>, size: number): { normals: Float32Array; objectIds: Int32Array } {
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

function copyChartRegion(
  src: Record<BakeChannelName, Float32Array>,
  dst: Record<BakeChannelName, Float32Array>,
  chart: ChartMeta,
  size: number,
): void {
  for (let y = 0; y < chart.heightPx; y++) {
    for (let x = 0; x < chart.widthPx; x++) {
      const index = ((chart.y + y) * size + chart.x + x) * 3
      for (const key of ['direct', 'indirect', 'ao'] as const) {
        dst[key][index] = src[key][index]
        dst[key][index + 1] = src[key][index + 1]
        dst[key][index + 2] = src[key][index + 2]
      }
    }
  }
}

async function persistBakeResult(
  hall: HallDoc,
  atlas: ReturnType<typeof buildLightmapAtlas>,
  result: BakeSchedulerResult,
  report: InvalidationReport | null,
): Promise<BakeRecord> {
  const blobs: StoredTexture['blobs'] = {}
  const rawBlobs: StoredTexture['rawBlobs'] = {}
  for (const key of ['direct', 'indirect', 'ao'] as const) {
    blobs[key] = await imageDataToBlob(channelToImageData(result.channels[key], atlas.size, atlas.size))
    rawBlobs[key] = await imageDataToBlob(channelToImageData(result.rawChannels[key], atlas.size, atlas.size))
  }
  const bakeId = `bake_${Date.now().toString(36)}`
  const record: BakeRecord = {
    id: bakeId,
    ...result.record,
    meanError: 0,
    rmse: 0,
    psnr: 0,
    invalidations: report?.entries ?? result.record.invalidations,
  }
  await hallRepository.saveBake(record, {
    bakeId,
    hallId: hall.id,
    atlasSize: atlas.size,
    blobs,
    rawBlobs,
    createdAt: Date.now(),
  })
  return record
}
