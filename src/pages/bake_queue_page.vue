<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { BakeRecord } from '../core/types'
import { editorStore } from '../stores/editor_store'
import { appStore } from '../stores/app_store'
import { hallRepository } from '../core/storage/hall_repository'
import { buildSceneGeometry } from '../core/geometry/geometry_builder'
import { buildLightmapAtlas } from '../core/uv_atlas'
import { analyzeInvalidation, takeSnapshot } from '../core/incremental_bake'
import { executeBake, type BakeRunOutcome } from '../core/bake_orchestrator'
import type { BakeProgress } from '../core/bake_scheduler'
import { WebGpuComputeBaker } from '../core/renderer/webgpu_compute_baker'
import SubNavigation from '../components/sub_navigation.vue'
import UiButton from '../components/ui_button.vue'
import UiPanel from '../components/ui_panel.vue'

const route = useRoute()
const hallId = route.params.id as string
const hall = computed(() => editorStore.state.hall)

const bakeHistory = ref<BakeRecord[]>([])
const running = ref(false)
const cancelled = ref(false)
const progress = ref<BakeProgress | null>(null)
const lastOutcome = ref<BakeRunOutcome | null>(null)
const gpuBaker = ref<WebGpuComputeBaker | null>(null)
const backendLabel = ref('')

const phaseLabels: Record<BakeProgress['phase'], string> = {
  prepare: '准备几何与 BVH',
  tracing: 'GPU/CPU 路径追踪',
  dilate: '边缘膨胀防接缝',
  denoise: '边缘保持降噪',
  finalize: '写入 IndexedDB',
}

const preAnalysis = computed(() => {
  if (!hall.value) return null
  const scene = buildSceneGeometry(hall.value)
  const atlas = buildLightmapAtlas(hall.value, scene)
  return { scene, atlas }
})

async function preflightIncremental(): Promise<{ canIncrement: boolean; affected: number; ratio: number; reasons: string[] }> {
  if (!hall.value) return { canIncrement: false, affected: 0, ratio: 0, reasons: [] }
  const snapshot = await hallRepository.getSnapshot(hall.value.id)
  if (!snapshot || !hall.value.lastBakeId) {
    return { canIncrement: false, affected: 0, ratio: 0, reasons: ['不存在历史烘焙快照，只能全量烘焙'] }
  }
  const report = analyzeInvalidation(hall.value, preAnalysis.value!.atlas, snapshot, takeSnapshot(hall.value))
  return {
    canIncrement: !report.fullBakeRecommended && report.affectedChartIds.size > 0,
    affected: report.affectedChartIds.size,
    ratio: report.affectedRatio,
    reasons: report.entries.slice(0, 8).map((e) => `${e.chartId}：${e.detail}`),
  }
}

const incrementalInfo = ref<Awaited<ReturnType<typeof preflightIncremental>> | null>(null)

async function startBake(forceFull: boolean): Promise<void> {
  if (!hall.value || running.value) return
  if (!forceFull && incrementalInfo.value?.ratio && incrementalInfo.value.ratio > 0.7) {
    const ok = window.confirm(
      `本次变更影响 ${(incrementalInfo.value.ratio * 100).toFixed(0)}% 的 chart，增量收益极低。\n点击确定执行全量烘焙，点击取消返回。`,
    )
    if (!ok) return
  }
  running.value = true
  cancelled.value = false
  progress.value = null
  const startedAt = performance.now()
  try {
    let baker: WebGpuComputeBaker | null = null
    if (appStore.state.gpu?.supported && appStore.state.gpu.device) {
      baker = new WebGpuComputeBaker(appStore.state.gpu.device)
      const compiled = await baker.compile()
      if (compiled) {
        gpuBaker.value = baker
        backendLabel.value = 'WebGPU compute'
      } else {
        baker = null
        backendLabel.value = 'CPU 路径追踪（WebGPU kernel 编译失败回落）'
      }
    } else {
      backendLabel.value = 'CPU 路径追踪（当前设备不支持 WebGPU）'
    }
    const iesList = await hallRepository.listIes()
    const iesById = new Map(iesList.map((p) => [p.id, p]))
    const outcome = await executeBake({
      hall: hall.value,
      forceFull,
      gpuBaker: baker,
      iesById,
      onProgress: (p) => (progress.value = p),
      isCancelled: () => cancelled.value,
    })
    lastOutcome.value = outcome
    appStore.notify('success', `烘焙完成，耗时 ${((performance.now() - startedAt) / 1000).toFixed(1)}s，后端：${backendLabel.value}`)
    await refreshHistory()
    await preflightIncremental().then((info) => (incrementalInfo.value = info))
  } catch (err) {
    appStore.notify('error', (err as Error).message)
  } finally {
    running.value = false
    progress.value = null
  }
}

function cancelBake(): void {
  cancelled.value = true
  appStore.notify('warning', '已请求取消，当前时间片结束后停止烘焙')
}

async function refreshHistory(): Promise<void> {
  if (!hall.value) return
  bakeHistory.value = await hallRepository.listBakes(hall.value.id)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

onMounted(async () => {
  const hallDoc = await editorStore.load(hallId)
  if (!hallDoc) return
  await refreshHistory()
  incrementalInfo.value = await preflightIncremental()
})
onBeforeUnmount(() => cancelBake())
</script>

<template>
  <div v-if="hall" class="bake-page">
    <SubNavigation :hall-id="hallId" />
    <div class="bake-body">
      <div class="bake-main flex flex-col gap-4">
        <UiPanel title="烘焙参数" description="采样数与弹射次数可调，后台按 chart 分块调度，界面保持可响应">
          <div class="settings-grid">
            <label class="setting-item">
              <span>图集边长</span>
              <select v-model.number="hall.bakeSettings.atlasSize" :disabled="running">
                <option :value="512">512 px</option>
                <option :value="1024">1024 px</option>
                <option :value="2048">2048 px</option>
              </select>
            </label>
            <label class="setting-item">
              <span>每纹素采样</span>
              <input v-model.number="hall.bakeSettings.samplesPerPixel" type="number" min="8" max="512" step="8" :disabled="running" />
            </label>
            <label class="setting-item">
              <span>弹射次数</span>
              <input v-model.number="hall.bakeSettings.bounceCount" type="number" min="0" max="6" step="1" :disabled="running" />
            </label>
            <label class="setting-item">
              <span>分块大小(chart)</span>
              <input v-model.number="hall.bakeSettings.chunkSize" type="number" min="1" max="8" step="1" :disabled="running" />
            </label>
            <label class="setting-item">
              <span>膨胀半径(px)</span>
              <input v-model.number="hall.bakeSettings.dilationRadius" type="number" min="1" max="12" step="1" :disabled="running" />
            </label>
            <label class="setting checkbox-row">
              <span>边缘保持降噪</span>
              <input v-model="hall.bakeSettings.denoise" type="checkbox" :disabled="running" />
            </label>
          </div>
        </UiPanel>

        <UiPanel title="烘焙任务">
          <div class="action-row">
            <UiButton variant="primary" :disabled="running" @click="startBake(true)">全量烘焙</UiButton>
            <UiButton :disabled="running || !incrementalInfo?.canIncrement" @click="startBake(false)">
              增量烘焙{{ incrementalInfo ? `（${incrementalInfo.affected} 块）` : '' }}
            </UiButton>
            <UiButton variant="danger" :disabled="!running" @click="cancelBake">取消任务</UiButton>
            <span class="backend-label">{{ backendLabel || '后端将在启动时自动选择' }}</span>
          </div>

          <div v-if="progress" class="progress-block">
            <div class="progress-meta">
              <span>{{ phaseLabels[progress.phase] }}</span>
              <span>{{ progress.finishedCharts }}/{{ progress.totalCharts }} chart · {{ (progress.overall * 100).toFixed(1) }}%</span>
              <span>已用 {{ formatDuration(progress.elapsedMs) }}</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: `${progress.overall * 100}%` }" />
            </div>
            <div v-if="progress.currentChartId" class="current-chart">当前 chart：{{ progress.currentChartId }}</div>
          </div>
        </UiPanel>

        <UiPanel title="增量烘焙失效依据" description="每块 chart 的重烘原因可审计，系统不会静默切换全量">
          <div v-if="!incrementalInfo" class="muted-text">正在分析场景变更…</div>
          <div v-else-if="incrementalInfo.reasons.length === 0" class="muted-text">
            无历史快照或场景未发生变化，保存布展/灯光调整后再执行增量烘焙
          </div>
          <ul v-else class="reason-list">
            <li v-for="(reason, i) in incrementalInfo.reasons" :key="i" class="reason-item">{{ reason }}</li>
          </ul>
          <div v-if="incrementalInfo && incrementalInfo.affected > 0" class="ratio-note" :class="{ warning: incrementalInfo.ratio > 0.7 }">
            受影响 chart 占比 {{ (incrementalInfo.ratio * 100).toFixed(1) }}%
            <template v-if="incrementalInfo.ratio > 0.7">，超过 70% 门槛，全量需手动确认</template>
          </div>
        </UiPanel>
      </div>

      <aside class="bake-side">
        <UiPanel title="烘焙历史">
          <div v-if="bakeHistory.length === 0" class="muted-text">还没有烘焙记录</div>
          <div v-else class="history-list">
            <article v-for="record in bakeHistory" :key="record.id" class="history-item">
              <div class="history-head">
                <span class="history-mode" :class="record.incremental ? 'incremental' : 'full'">
                  {{ record.incremental ? '增量' : '全量' }}
                </span>
                <span class="history-time">{{ new Date(record.finishedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
              </div>
              <div class="history-meta">
                {{ record.sampleCount }} spp · {{ record.bounceCount }} 弹射 · {{ formatDuration(record.elapsedMs) }}
              </div>
              <div class="history-meta">
                {{ record.atlasSize }}px · {{ record.denoised ? '已降噪' : '未降噪' }} · 失效 {{ record.invalidations.length }} 块
              </div>
            </article>
          </div>
        </UiPanel>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.bake-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.bake-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  overflow: auto;
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-3);
}
.setting-item {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  color: var(--text-secondary);
}
.setting-item input,
.setting-item select {
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  color: var(--text-primary);
}
.setting-item input:focus,
.setting-item select:focus {
  outline: none;
  border-color: var(--primary-500);
}
.checkbox-row {
  flex-direction: row;
  align-items: center;
  gap: var(--sp-2);
}
.action-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.backend-label {
  color: var(--text-muted);
}
.progress-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  color: var(--text-secondary);
}
.progress-track {
  height: 8px;
  border-radius: 999px;
  background: var(--bg-inset);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-600), var(--primary-400));
  transition: width var(--t-fast);
}
.current-chart {
  color: var(--text-muted);
}
.reason-list {
  margin: 0;
  padding-left: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  color: var(--text-secondary);
}
.ratio-note {
  margin-top: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: rgba(52, 211, 153, 0.1);
  color: var(--success);
}
.ratio-note.warning {
  background: rgba(251, 191, 36, 0.12);
  color: var(--warning);
}
.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.history-item {
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.history-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.history-mode {
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
}
.history-mode.full {
  background: rgba(14, 165, 233, 0.15);
  color: var(--primary-300);
}
.history-mode.incremental {
  background: rgba(52, 211, 153, 0.15);
  color: var(--success);
}
.history-time,
.history-meta {
  color: var(--text-muted);
}
.muted-text {
  color: var(--text-muted);
}
</style>
