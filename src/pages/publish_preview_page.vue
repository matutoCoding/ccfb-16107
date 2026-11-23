<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { BakeChannelName, PublishPackage, Vec3 } from '../core/types'
import { editorStore } from '../stores/editor_store'
import { appStore } from '../stores/app_store'
import { hallRepository } from '../core/storage/hall_repository'
import { decodeTextureChannels } from '../core/storage/texture_codec'
import { buildWalkPath, formatBytes, publishTextures } from '../core/publish'
import { autoPlaceProbes, bakeProbe, type ProbeBakeResult } from '../core/reflection_probe'
import { buildSceneGeometry } from '../core/geometry/geometry_builder'
import { buildBvh } from '../core/bvh'
import SubNavigation from '../components/sub_navigation.vue'
import UiButton from '../components/ui_button.vue'
import UiPanel from '../components/ui_panel.vue'
import PreviewCanvas from '../components/preview_canvas.vue'
import type { OrbitCamera } from '../core/renderer/canvas_preview_renderer'
import { degToRad, v3 } from '../core/math3d'

const route = useRoute()
const hallId = route.params.id as string
const hall = computed(() => editorStore.state.hall)

const publishing = ref(false)
const publishResult = ref<{
  tier: 'desktop' | 'mobile'
  totalBytes: number
  budgetBytes: number
  resizeLog: string[]
  textureUrl: string
} | null>(null)
const walkPath = ref<Vec3[]>([])
const walkIndex = ref(0)
const autoWalking = ref(false)
const walkTimer = ref<number | null>(null)
const probeResults = ref<ProbeBakeResult[]>([])
const probeBaking = ref(false)
const previewCanvas = ref<InstanceType<typeof PreviewCanvas> | null>(null)

const mobileFrameStyle = {
  width: '375px',
  height: '680px',
  borderRadius: '28px',
  border: '6px solid var(--slate-700)',
  overflow: 'hidden',
  background: 'var(--slate-950)',
}

async function publish(tier: 'desktop' | 'mobile'): Promise<void> {
  if (!hall.value?.lastBakeId) {
    appStore.notify('warning', '请先完成烘焙再发布')
    return
  }
  publishing.value = true
  try {
    const stored = await hallRepository.getBake(hall.value.lastBakeId)
    if (!stored) throw new Error('烘焙纹理读取失败')
    const channels = await decodeTextureChannels(stored.texture, stored.record.atlasSize)
    const result = await publishTextures({ tier, channels, atlasSize: stored.record.atlasSize })
    if (publishResult.value?.textureUrl) URL.revokeObjectURL(publishResult.value.textureUrl)
    const textureUrl = URL.createObjectURL(result.texture.blob)
    publishResult.value = {
      tier,
      totalBytes: result.packageInfo.totalBytes,
      budgetBytes: result.packageInfo.budgetBytes,
      resizeLog: result.resizeLog,
      textureUrl,
    }
    const pkg: PublishPackage = {
      id: `pkg_${Date.now().toString(36)}`,
      hallId: hall.value.id,
      tier,
      totalBytes: result.packageInfo.totalBytes,
      budgetBytes: result.packageInfo.budgetBytes,
      exportedAt: Date.now(),
      walkPath: walkPath.value,
    }
    await hallRepository.savePublish(pkg, result.texture.blob)
    appStore.notify('success', `${tier === 'mobile' ? '手机' : '电脑'}档发布包已生成并存入 IndexedDB`)
  } catch (err) {
    appStore.notify('error', (err as Error).message)
  } finally {
    publishing.value = false
  }
}

async function bakeProbes(): Promise<void> {
  if (!hall.value) return
  probeBaking.value = true
  try {
    const probes = autoPlaceProbes(hall.value)
    await hallRepository.saveProbes(hall.value.id, probes)
    const scene = buildSceneGeometry(hall.value)
    const bvh = buildBvh(scene, hall.value.objects)
    // 分帧执行避免卡顿
    probeResults.value = []
    for (const probe of probes) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      probeResults.value.push(bakeProbe(probe, hall.value, bvh, 12))
    }
    appStore.notify('success', `已按展柜位置自动放置并烘焙 ${probes.length} 个反射探针`)
  } finally {
    probeBaking.value = false
  }
}

function prepareWalk(): void {
  if (!hall.value) return
  walkPath.value = buildWalkPath(hall.value)
  walkIndex.value = 0
  appStore.notify('info', `展线生成：${walkPath.value.length} 个相机停靠点`)
}

function stepWalk(): void {
  if (!hall.value || walkPath.value.length === 0) prepareWalk()
  if (walkIndex.value >= walkPath.value.length) {
    stopWalk()
    return
  }
  const point = walkPath.value[walkIndex.value]
  const next = walkPath.value[Math.min(walkIndex.value + 1, walkPath.value.length - 1)]
  const forward = v3.normalize([next[0] - point[0], next[1] - point[1], next[2] - point[2]])
  const yaw = Math.atan2(forward[0], forward[2])
  // 相机在停靠点，看向展线前方，手机视口保持人眼高度
  previewCanvas.value?.moveCamera({
    target: [point[0] + forward[0] * 4, 1.4, point[2] + forward[2] * 4],
    yaw,
    pitch: 0.04,
    distance: 5,
    fovYRad: degToRad(60),
  })
  walkIndex.value += 1
}

function startWalk(): void {
  prepareWalk()
  autoWalking.value = true
  walkTimer.value = window.setInterval(() => {
    stepWalk()
    if (walkIndex.value >= walkPath.value.length) stopWalk()
  }, 1800)
}

function stopWalk(): void {
  autoWalking.value = false
  if (walkTimer.value) {
    clearInterval(walkTimer.value)
    walkTimer.value = null
  }
}

const budgetRatio = computed(() => {
  if (!publishResult.value) return 0
  return publishResult.value.totalBytes / publishResult.value.budgetBytes
})

onMounted(async () => {
  const hallDoc = await editorStore.load(hallId)
  if (hallDoc) prepareWalk()
})
</script>

<template>
  <div v-if="hall" class="publish-page">
    <SubNavigation :hall-id="hallId" />
    <div class="publish-body">
      <div class="publish-main flex flex-col gap-4">
        <UiPanel title="手机分辨率展线预览" description="按 375px 视口沿展线巡检，发布端只读贴图，不运行实时光照">
          <div class="phone-stage">
            <div :style="mobileFrameStyle">
              <PreviewCanvas ref="previewCanvas" :hall="hall" :height="668" />
            </div>
            <div class="walk-panel">
              <div class="walk-stats">
                <div>停靠点：{{ walkPath.length }}</div>
                <div>当前：{{ Math.min(walkIndex, walkPath.length) }} / {{ walkPath.length }}</div>
              </div>
              <div class="walk-actions">
                <UiButton size="sm" :disabled="autoWalking" @click="startWalk">自动巡览</UiButton>
                <UiButton size="sm" :disabled="!autoWalking" @click="stopWalk">停止</UiButton>
                <UiButton size="sm" @click="stepWalk">单步</UiButton>
              </div>
              <ol class="path-list">
                <li v-for="(point, i) in walkPath" :key="i" :class="{ current: i === walkIndex - 1 }">
                  点 {{ i + 1 }} · ({{ point[0].toFixed(1) }}, {{ point[2].toFixed(1) }})
                </li>
              </ol>
            </div>
          </div>
        </UiPanel>

        <UiPanel title="发布贴图预览">
          <div v-if="!publishResult" class="muted-text">选择档位发布后在此预览压缩贴图</div>
          <div v-else class="publish-result">
            <img :src="publishResult.textureUrl" class="published-image" alt="发布光照贴图" />
            <div class="publish-meta">
              <div class="meta-row">
                <span>档位</span>
                <span>{{ publishResult.tier === 'mobile' ? '手机端' : '电脑端' }}</span>
              </div>
              <div class="meta-row">
                <span>总体积</span>
                <span :style="{ color: budgetRatio > 1 ? 'var(--danger)' : 'var(--success)' }">
                  {{ formatBytes(publishResult.totalBytes) }} / {{ formatBytes(publishResult.budgetBytes) }}
                </span>
              </div>
              <div class="budget-track">
                <div class="budget-fill" :class="{ over: budgetRatio > 1 }" :style="{ width: `${Math.min(100, budgetRatio * 100)}%` }" />
              </div>
              <div class="resize-log">
                <div v-for="(line, i) in publishResult.resizeLog" :key="i">{{ line }}</div>
              </div>
            </div>
          </div>
        </UiPanel>
      </div>

      <aside class="publish-side flex flex-col gap-4">
        <UiPanel title="发布档位" description="手机端总贴图预算硬上限 16MB，超预算自动降分辨率">
          <div class="publish-actions">
            <UiButton variant="primary" :disabled="publishing" @click="publish('mobile')">
              {{ publishing ? '打包中…' : '发布手机端' }}
            </UiButton>
            <UiButton :disabled="publishing" @click="publish('desktop')">发布电脑端</UiButton>
          </div>
        </UiPanel>

        <UiPanel title="反射探针" description="展柜玻璃与展品高光由探针补充，按展柜位置自动布点">
          <div class="probe-info">
            <div>已烘焙探针：{{ probeResults.length }} 个</div>
            <div class="muted-text">每个探针 64px 立方体贴图，覆盖对应展柜区域</div>
          </div>
          <UiButton size="sm" :disabled="probeBaking" @click="bakeProbes">
            {{ probeBaking ? '探针烘焙中…' : '自动放置并烘焙探针' }}
          </UiButton>
          <div v-if="probeResults.length > 0" class="probe-grid">
            <div v-for="result in probeResults" :key="result.probeId" class="probe-cell">
              <span>{{ result.probeId }}</span>
            </div>
          </div>
        </UiPanel>

        <UiPanel title="发布说明">
          <ul class="note-list">
            <li>手机端运行时只采样烘焙贴图与探针，不执行实时光照计算</li>
            <li>贴图使用 WebP 编码，按预算逐级降档并记录压缩轨迹</li>
            <li>展线由展柜/展台位置自动生成，支持自动巡览与单步检查</li>
            <li>发布包与布展方案同库存储，可离线读取</li>
          </ul>
        </UiPanel>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.publish-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.publish-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  overflow: auto;
}
.phone-stage {
  display: flex;
  gap: var(--sp-5);
  align-items: flex-start;
  flex-wrap: wrap;
}
.walk-panel {
  flex: 1;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.walk-stats {
  display: flex;
  justify-content: space-between;
  color: var(--text-secondary);
}
.walk-actions {
  display: flex;
  gap: var(--sp-2);
}
.path-list {
  margin: 0;
  padding-left: var(--sp-4);
  max-height: 320px;
  overflow-y: auto;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.path-list li.current {
  color: var(--primary-300);
}
.publish-result {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: var(--sp-4);
}
.published-image {
  width: 100%;
  image-rendering: pixelated;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
}
.publish-meta {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.meta-row {
  display: flex;
  justify-content: space-between;
}
.budget-track {
  height: 8px;
  border-radius: 999px;
  background: var(--bg-inset);
  overflow: hidden;
}
.budget-fill {
  height: 100%;
  background: var(--success);
}
.budget-fill.over {
  background: var(--danger);
}
.resize-log {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text-muted);
}
.publish-actions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.probe-info {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  color: var(--text-secondary);
}
.probe-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-2);
}
.probe-cell {
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  color: var(--text-muted);
}
.note-list {
  margin: 0;
  padding-left: var(--sp-4);
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.muted-text {
  color: var(--text-muted);
}
</style>
