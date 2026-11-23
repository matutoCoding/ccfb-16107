<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { IesProfile, LightConfig, LightKind } from '../core/types'
import { editorStore } from '../stores/editor_store'
import { appStore } from '../stores/app_store'
import { hallRepository } from '../core/storage/hall_repository'
import { parseIes, sampleIes } from '../core/ies'
import SubNavigation from '../components/sub_navigation.vue'
import UiButton from '../components/ui_button.vue'
import UiPanel from '../components/ui_panel.vue'
import PreviewCanvas from '../components/preview_canvas.vue'

const route = useRoute()
const hallId = route.params.id as string
const selectedLightId = ref<string | null>(null)
const iesProfiles = ref<IesProfile[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

const hall = computed(() => editorStore.state.hall)
const selectedLight = computed(() => hall.value?.lights.find((l) => l.id === selectedLightId.value) ?? null)

const kindLabels: Record<LightKind, string> = {
  spot: '轨道射灯',
  wallwash: '洗墙灯',
  linear: '线形灯',
  skylight: '天窗自然光',
}

let lightSeq = 0
function addLight(kind: LightKind): void {
  if (!hall.value) return
  lightSeq += 1
  const presets: Record<LightKind, Omit<LightConfig, 'id' | 'name'>> = {
    spot: { kind, position: [0, 4.6, 0], target: [0, 1, -1], color: [1, 0.92, 0.8], intensity: 2.2, beamAngle: 22, length: 0, castShadow: true, iesProfileId: null },
    wallwash: { kind, position: [0, 4.2, -5.4], target: [0, 2, -6], color: [1, 0.95, 0.88], intensity: 1.6, beamAngle: 45, length: 0, castShadow: false, iesProfileId: null },
    linear: { kind, position: [0, 2.3, -2], target: [0, 0, -2], color: [1, 1, 1], intensity: 1.2, beamAngle: 60, length: 1.2, castShadow: false, iesProfileId: null },
    skylight: { kind, position: [0, 4.8, 2], target: [0, 0, 2], color: [0.82, 0.9, 1], intensity: 1.1, beamAngle: 60, length: 0, castShadow: true, iesProfileId: null },
  }
  const light: LightConfig = {
    id: `light_${Date.now().toString(36)}_${lightSeq}`,
    name: `${kindLabels[kind]} ${hall.value.lights.filter((l) => l.kind === kind).length + 1}`,
    ...presets[kind],
  }
  hall.value.lights.push(light)
  selectedLightId.value = light.id
  editorStore.markDirty()
}

function removeLight(): void {
  if (!hall.value || !selectedLight.value) return
  hall.value.lights = hall.value.lights.filter((l) => l.id !== selectedLight.value?.id)
  selectedLightId.value = null
  editorStore.markDirty()
}

async function onIesFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const profile = parseIes(file.name, text)
    await hallRepository.saveIes(profile)
    iesProfiles.value = await hallRepository.listIes()
    if (selectedLight.value) {
      selectedLight.value.iesProfileId = profile.id
      editorStore.markDirty()
    }
    appStore.notify('success', `IES 配光「${file.name}」导入成功，已绑定当前射灯`)
  } catch (err) {
    appStore.notify('error', `IES 解析失败：${(err as Error).message}`)
  } finally {
    input.value = ''
  }
}

// 配光曲线预览数据：0~90 度归一化光强
const iesCurve = computed(() => {
  if (!selectedLight.value?.iesProfileId) return []
  const profile = iesProfiles.value.find((p) => p.id === selectedLight.value?.iesProfileId)
  if (!profile) return []
  return Array.from({ length: 19 }, (_, i) => {
    const angle = i * 5
    return { angle, value: sampleIes(profile, angle) }
  })
})

async function save(): Promise<void> {
  await editorStore.persist(true)
  appStore.notify('success', '灯光方案已保存并递增场景版本')
}

onMounted(async () => {
  const hallDoc = await editorStore.load(hallId)
  if (!hallDoc) return
  selectedLightId.value = hallDoc.lights[0]?.id ?? null
  iesProfiles.value = await hallRepository.listIes()
})
</script>

<template>
  <div v-if="hall" class="light-page">
    <SubNavigation :hall-id="hallId" />
    <div class="light-body">
      <div class="light-main flex flex-col gap-4">
        <UiPanel title="灯光分布预览" description="黄点为人工光源，蓝点为天窗自然光，位置与朝向实时同步">
          <PreviewCanvas :hall="hall" :height="440" />
        </UiPanel>

        <UiPanel title="IES 配光曲线" description="导入 IES LM-63 文件后按角度显示归一化光强，烘焙时直接查表">
          <div v-if="iesCurve.length === 0" class="muted-text">当前射灯未绑定 IES 文件，使用光束角余弦截断配光</div>
          <div v-else class="ies-chart">
            <div v-for="point in iesCurve" :key="point.angle" class="ies-bar-wrap">
              <div class="ies-bar" :style="{ height: `${point.value * 120}px` }" />
              <span class="ies-angle">{{ point.angle }}°</span>
            </div>
          </div>
        </UiPanel>
      </div>

      <aside class="light-side flex flex-col gap-4">
        <UiPanel title="添加灯光">
          <div class="light-add-grid">
            <UiButton size="sm" @click="addLight('spot')">+ 轨道射灯</UiButton>
            <UiButton size="sm" @click="addLight('wallwash')">+ 洗墙灯</UiButton>
            <UiButton size="sm" @click="addLight('linear')">+ 线形灯</UiButton>
            <UiButton size="sm" @click="addLight('skylight')">+ 天窗光</UiButton>
          </div>
        </UiPanel>

        <UiPanel title="灯光参数">
          <div v-if="!selectedLight" class="muted-text">选择一盏灯进行编辑</div>
          <div v-else class="light-form">
            <div class="form-row">
              <span class="form-label">名称</span>
              <input v-model="selectedLight.name" class="form-input" @change="editorStore.markDirty()" />
            </div>
            <div class="form-row">
              <span class="form-label">类型</span>
              <span class="form-value">{{ kindLabels[selectedLight.kind] }}</span>
            </div>
            <div v-for="(axis, idx) in (['X', 'Y', 'Z'] as const)" :key="`lp${axis}`" class="form-row">
              <span class="form-label">位置 {{ axis }}</span>
              <input v-model.number="selectedLight.position[idx]" type="number" step="0.1" class="form-input" @change="editorStore.markDirty()" />
            </div>
            <div v-for="(axis, idx) in (['X', 'Y', 'Z'] as const)" :key="`lt${axis}`" class="form-row">
              <span class="form-label">目标 {{ axis }}</span>
              <input v-model.number="selectedLight.target[idx]" type="number" step="0.1" class="form-input" @change="editorStore.markDirty()" />
            </div>
            <div class="form-row">
              <span class="form-label">强度(lm)</span>
              <input v-model.number="selectedLight.intensity" type="number" step="0.1" min="0" class="form-input" @change="editorStore.markDirty()" />
            </div>
            <div v-if="selectedLight.kind === 'spot'" class="form-row">
              <span class="form-label">光束角°</span>
              <input v-model.number="selectedLight.beamAngle" type="number" step="1" min="5" max="85" class="form-input" @change="editorStore.markDirty()" />
            </div>
            <div v-if="selectedLight.kind === 'linear'" class="form-row">
              <span class="form-label">灯长 m</span>
              <input v-model.number="selectedLight.length" type="number" step="0.05" min="0.1" class="form-input" @change="editorStore.markDirty()" />
            </div>
            <div class="form-row">
              <span class="form-label">投影阴影</span>
              <input v-model="selectedLight.castShadow" type="checkbox" @change="editorStore.markDirty()" />
            </div>
            <div v-if="selectedLight.kind === 'spot'" class="form-row ies-row">
              <span class="form-label">IES 文件</span>
              <select v-model="selectedLight.iesProfileId" class="form-input" @change="editorStore.markDirty()">
                <option :value="null">默认余弦配光</option>
                <option v-for="p in iesProfiles" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <input ref="fileInput" type="file" accept=".ies" class="hidden" @change="onIesFile" />
            <UiButton v-if="selectedLight.kind === 'spot'" size="sm" @click="fileInput?.click()">导入 IES 配光文件</UiButton>
            <UiButton variant="danger" size="sm" @click="removeLight">删除该灯光</UiButton>
          </div>
        </UiPanel>

        <UiPanel title="灯光列表">
          <div class="light-list">
            <button v-for="light in hall.lights" :key="light.id" class="light-item" :class="{ active: light.id === selectedLightId }" @click="selectedLightId = light.id">
              <span>{{ light.name }}</span>
              <span class="light-type">{{ kindLabels[light.kind] }}</span>
            </button>
          </div>
        </UiPanel>

        <UiButton variant="primary" @click="save">保存灯光方案</UiButton>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.light-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.light-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  overflow: auto;
}
.light-add-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-2);
}
.light-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.form-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.form-label {
  width: 76px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.form-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
  color: var(--text-primary);
}
.form-input:focus {
  outline: none;
  border-color: var(--primary-500);
}
.form-value {
  color: var(--text-primary);
}
.muted-text {
  color: var(--text-muted);
}
.ies-chart {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-1);
  height: 160px;
  overflow-x: auto;
  padding-bottom: var(--sp-2);
}
.ies-bar-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-1);
  min-width: 28px;
}
.ies-bar {
  width: 18px;
  background: linear-gradient(180deg, var(--primary-400), var(--primary-600));
  border-radius: 2px 2px 0 0;
  min-height: 2px;
}
.ies-angle {
  color: var(--text-muted);
  font-size: var(--fs-xs);
}
.light-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  max-height: 220px;
  overflow-y: auto;
}
.light-item {
  display: flex;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  color: var(--text-secondary);
  text-align: left;
}
.light-item:hover {
  background: var(--bg-inset);
}
.light-item.active {
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.4);
  color: var(--primary-300);
}
.light-type {
  color: var(--text-muted);
}
.hidden {
  display: none;
}
</style>
