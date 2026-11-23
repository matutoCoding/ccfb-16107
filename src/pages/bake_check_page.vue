<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { BakeChannelName, BakeRecord, Vec3 } from '../core/types'
import { editorStore } from '../stores/editor_store'
import { appStore } from '../stores/app_store'
import { hallRepository } from '../core/storage/hall_repository'
import { decodeTextureChannels, paintPixels } from '../core/storage/texture_codec'
import { buildSceneGeometry } from '../core/geometry/geometry_builder'
import { buildBvh } from '../core/bvh'
import { buildLightmapAtlas } from '../core/uv_atlas'
import { composeChannels } from '../core/texture_utils'
import {
  buildDensityHeatmap,
  computeErrorMap,
  detectLightLeak,
  detectSeamDiscontinuity,
  evaluateQuality,
  type ErrorMetrics,
  type LeakFinding,
  type SeamFinding,
} from '../core/quality_inspector'
import { renderReferenceFrame } from '../core/path_tracer'
import { degToRad } from '../core/math3d'
import SubNavigation from '../components/sub_navigation.vue'
import UiButton from '../components/ui_button.vue'
import UiPanel from '../components/ui_panel.vue'
import PreviewCanvas from '../components/preview_canvas.vue'

const route = useRoute()
const hallId = route.params.id as string
const hall = computed(() => editorStore.state.hall)

const bakeRecords = ref<BakeRecord[]>([])
const selectedBakeId = ref<string | null>(null)
const channels = ref<Record<BakeChannelName, Float32Array> | null>(null)
const rawChannels = ref<Record<BakeChannelName, Float32Array> | null>(null)
const viewMode = ref<'composed' | BakeChannelName | 'density' | 'error' | 'raw'>('composed')
const metrics = ref<ErrorMetrics | null>(null)
const leaks = ref<LeakFinding[]>([])
const seams = ref<SeamFinding[]>([])
const analyzing = ref(false)
const showDenoiseCompare = ref(false)
const showMarkers = ref(true)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const atlasSize = computed(() => hall.value?.bakeSettings.atlasSize ?? 1024)
const atlasReport = computed(() => (hall.value ? buildLightmapAtlas(hall.value, buildSceneGeometry(hall.value)) : null))

const selectedRecord = computed(() => bakeRecords.value.find((r) => r.id === selectedBakeId.value) ?? null)

const verdict = computed(() => {
  if (!metrics.value) return null
  return evaluateQuality(hall.value!, metrics.value, seams.value, leaks.value)
})

const overlay = computed(() => {
  if (!hall.value || !showMarkers.value) return { markers: [], highlightChartObjectId: null }
  const markers = leaks.value.slice(0, 20).map((f) => {
    const obj = hall.value!.objects.find((o) => o.id === f.objectId)
    return {
      position: (obj?.position ?? [0, 1, 0]) as Vec3,
      color: f.kind === 'light-leak' ? '#f87171' : '#fbbf24',
      label: f.kind === 'light-leak' ? '漏光' : '阴影错位',
    }
  })
  return { markers, highlightChartObjectId: null }
})

async function loadBake(bakeId: string): Promise<void> {
  if (!hall.value) return
  selectedBakeId.value = bakeId
  const stored = await hallRepository.getBake(bakeId)
  if (!stored) {
    appStore.notify('error', '烘焙纹理缺失，可能已被清理')
    return
  }
  channels.value = await decodeTextureChannels(stored.texture, stored.record.atlasSize)
  rawChannels.value = await decodeTextureChannels(
    { ...stored.texture, blobs: stored.texture.rawBlobs },
    stored.record.atlasSize,
  )
  await runAnalysis()
}

async function runAnalysis(): Promise<void> {
  if (!hall.value || !channels.value || !atlasReport.value) return
  analyzing.value = true
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    const scene = buildSceneGeometry(hall.value)
    const bvh = buildBvh(scene, hall.value.objects)
    const iesList = await hallRepository.listIes()
    const iesById = new Map(iesList.map((p) => [p.id, p]))
    // 参考图：相机放在厅入口沿展线方向，低分辨率逐像素路径追踪
    const reference = renderReferenceFrame(
      { hall: hall.value, bvh, scene, iesById },
      atlasSize.value,
      atlasSize.value,
      [0, 1.6, hall.value.dimensions[2] / 2 - 0.8],
      [0, -0.05, -1],
      degToRad(55),
      Math.min(32, hall.value.bakeSettings.samplesPerPixel),
    )
    metrics.value = computeErrorMap(channels.value, reference, atlasReport.value)
    leaks.value = detectLightLeak(channels.value, atlasReport.value)
    seams.value = detectSeamDiscontinuity(channels.value, atlasReport.value)

    if (selectedRecord.value) {
      selectedRecord.value.meanError = metrics.value.meanError
      selectedRecord.value.rmse = metrics.value.rmse
      selectedRecord.value.psnr = metrics.value.psnr
      const stored = await hallRepository.getBake(selectedRecord.value.id)
      if (stored) await hallRepository.saveBake(selectedRecord.value, stored.texture)
    }
    appStore.notify('success', '质检完成，误差图与问题标注已生成')
  } finally {
    analyzing.value = false
  }
}

function renderCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas || !channels.value || !atlasReport.value) return
  const size = atlasSize.value
  canvas.width = size
  canvas.height = size
  if (viewMode.value === 'density') {
    const heat = buildDensityHeatmap(atlasReport.value)
    paintPixels(canvas, heat.image, size, true)
    return
  }
  if (viewMode.value === 'error' && metrics.value) {
    paintPixels(canvas, metrics.value.errorMap, size, true)
    return
  }
  if (viewMode.value === 'raw' && rawChannels.value) {
    paintPixels(canvas, composeChannels(rawChannels.value, size * size), size)
    return
  }
  if (viewMode.value === 'composed') {
    paintPixels(canvas, composeChannels(channels.value, size * size), size)
    return
  }
  paintPixels(canvas, channels.value[viewMode.value as BakeChannelName], size)
}

watch([channels, viewMode, metrics], renderCanvas)

const viewModes: Array<{ key: typeof viewMode.value; label: string }> = [
  { key: 'composed', label: '合成光照' },
  { key: 'direct', label: '直接光' },
  { key: 'indirect', label: '间接光' },
  { key: 'ao', label: 'AO 遮蔽' },
  { key: 'density', label: '纹素密度热力图' },
  { key: 'error', label: '逐像素误差图' },
  { key: 'raw', label: '降噪前原图' },
]

onMounted(async () => {
  const hallDoc = await editorStore.load(hallId)
  if (!hallDoc) return
  bakeRecords.value = await hallRepository.listBakes(hallId)
  if (hallDoc.lastBakeId) await loadBake(hallDoc.lastBakeId)
})
</script>

<template>
  <div v-if="hall" class="check-page">
    <SubNavigation :hall-id="hallId" />
    <div class="check-body">
      <div class="check-main flex flex-col gap-4">
        <UiPanel title="烘焙纹理检查" description="各通道独立查看，热力图暴露密度失衡，误差图逐像素对比参考路径追踪">
          <div class="mode-row">
            <button
              v-for="mode in viewModes"
              :key="mode.key"
              class="mode-chip"
              :class="{ active: viewMode === mode.key }"
              @click="viewMode = mode.key"
            >
              {{ mode.label }}
            </button>
          </div>
          <div v-if="!selectedRecord" class="empty-tip">请先在烘焙队列页完成一次烘焙</div>
          <div v-else class="canvas-frame">
            <canvas ref="canvasRef" class="atlas-canvas" />
          </div>
          <div class="compare-row">
            <label class="compare-check">
              <input v-model="showDenoiseCompare" type="checkbox" />
              降噪前后对比（鼠标在「降噪前原图」与合成光照间切换查看纹饰细节）
            </label>
            <label class="compare-check">
              <input v-model="showMarkers" type="checkbox" />
              在 3D 模型上标注漏光与阴影错位
            </label>
          </div>
        </UiPanel>

        <UiPanel title="模型问题标注">
          <PreviewCanvas :hall="hall" :overlay="overlay" :height="360" />
        </UiPanel>
      </div>

      <aside class="check-side flex flex-col gap-4">
        <UiPanel title="烘焙记录">
          <div v-if="bakeRecords.length === 0" class="muted-text">暂无烘焙记录</div>
          <div v-else class="record-list">
            <button
              v-for="record in bakeRecords"
              :key="record.id"
              class="record-item"
              :class="{ active: record.id === selectedBakeId }"
              @click="loadBake(record.id)"
            >
              <span>{{ record.incremental ? '增量烘焙' : '全量烘焙' }} · {{ record.atlasSize }}px</span>
              <span class="record-time">{{ new Date(record.finishedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
            </button>
          </div>
          <UiButton size="sm" :disabled="!selectedRecord || analyzing" @click="runAnalysis">
            {{ analyzing ? '正在重新质检…' : '重新运行质检' }}
          </UiButton>
        </UiPanel>

        <UiPanel title="验收指标（门槛：平均误差 < 2%）">
          <div v-if="!metrics" class="muted-text">完成质检后显示量化指标</div>
          <div v-else class="metric-list">
            <div class="metric-row">
              <span>平均误差</span>
              <span :style="{ color: metrics.meanError < 0.02 ? 'var(--success)' : 'var(--danger)' }">
                {{ (metrics.meanError * 100).toFixed(2) }}%
              </span>
            </div>
            <div class="metric-row">
              <span>RMSE</span>
              <span>{{ metrics.rmse.toFixed(4) }}</span>
            </div>
            <div class="metric-row">
              <span>PSNR</span>
              <span>{{ metrics.psnr.toFixed(1) }} dB</span>
            </div>
            <div class="metric-row">
              <span>最大误差</span>
              <span>{{ (metrics.maxError * 100).toFixed(2) }}%</span>
            </div>
            <div class="metric-row">
              <span>超阈值纹素</span>
              <span>{{ (metrics.overThresholdRatio * 100).toFixed(2) }}%</span>
            </div>
          </div>
        </UiPanel>

        <UiPanel title="自动检查结论">
          <div v-if="!verdict" class="muted-text">等待质检数据</div>
          <div v-else>
            <div class="verdict-banner" :class="verdict.passed ? 'pass' : 'fail'">
              {{ verdict.passed ? '验收通过' : '验收未通过' }}
            </div>
            <ul class="verdict-notes">
              <li v-for="(note, i) in verdict.notes" :key="i">{{ note }}</li>
            </ul>
            <div class="finding-counts">
              <span>漏光/错位 {{ leaks.length }} 处</span>
              <span>接缝色差 {{ seams.length }} 处</span>
            </div>
          </div>
        </UiPanel>

        <UiPanel title="问题明细（前 10 条）">
          <div v-if="leaks.length === 0 && seams.length === 0" class="muted-text">未发现漏光、阴影错位或接缝问题</div>
          <ul v-else class="finding-list">
            <li v-for="(f, i) in leaks.slice(0, 10)" :key="`l${i}`" class="finding-item leak">
              <span class="finding-tag">{{ f.kind === 'light-leak' ? '漏光' : '阴影' }}</span>
              <span>{{ f.description }}</span>
            </li>
            <li v-for="(s, i) in seams.slice(0, 10)" :key="`s${i}`" class="finding-item seam">
              <span class="finding-tag">接缝</span>
              <span>{{ s.chartId }} 色差 {{ s.deltaE.toFixed(3) }}</span>
            </li>
          </ul>
        </UiPanel>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.check-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.check-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  overflow: auto;
}
.mode-row {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.mode-chip {
  padding: var(--sp-1) var(--sp-3);
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  transition: all var(--t-fast);
}
.mode-chip.active {
  background: rgba(14, 165, 233, 0.15);
  border-color: var(--primary-500);
  color: var(--primary-300);
}
.canvas-frame {
  background: var(--slate-950);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  display: flex;
  justify-content: center;
}
.atlas-canvas {
  width: 100%;
  max-width: 560px;
  aspect-ratio: 1;
  image-rendering: pixelated;
}
.empty-tip,
.muted-text {
  color: var(--text-muted);
}
.compare-row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  color: var(--text-secondary);
}
.compare-check {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.record-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-bottom: var(--sp-3);
}
.record-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  color: var(--text-secondary);
  text-align: left;
}
.record-item.active {
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.4);
  color: var(--primary-300);
}
.record-time {
  color: var(--text-muted);
}
.metric-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.metric-row {
  display: flex;
  justify-content: space-between;
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--border-color);
}
.verdict-banner {
  padding: var(--sp-3);
  border-radius: var(--radius-sm);
  text-align: center;
  font-weight: var(--fw-semibold);
  margin-bottom: var(--sp-3);
}
.verdict-banner.pass {
  background: rgba(52, 211, 153, 0.12);
  color: var(--success);
}
.verdict-banner.fail {
  background: rgba(248, 113, 113, 0.12);
  color: var(--danger);
}
.verdict-notes {
  margin: 0;
  padding-left: var(--sp-4);
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.finding-counts {
  display: flex;
  justify-content: space-between;
  margin-top: var(--sp-3);
  color: var(--text-muted);
}
.finding-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.finding-item {
  display: flex;
  gap: var(--sp-2);
  align-items: flex-start;
  color: var(--text-secondary);
}
.finding-tag {
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  flex-shrink: 0;
}
.finding-item.leak .finding-tag {
  background: rgba(248, 113, 113, 0.15);
  color: var(--danger);
}
.finding-item.seam .finding-tag {
  background: rgba(251, 191, 36, 0.15);
  color: var(--warning);
}
</style>
