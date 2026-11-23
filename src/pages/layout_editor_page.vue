<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { ObjectKind, SceneObject } from '../core/types'
import { editorStore } from '../stores/editor_store'
import { appStore } from '../stores/app_store'
import { buildSceneGeometry } from '../core/geometry/geometry_builder'
import { buildLightmapAtlas } from '../core/uv_atlas'
import SubNavigation from '../components/sub_navigation.vue'
import UiButton from '../components/ui_button.vue'
import UiPanel from '../components/ui_panel.vue'
import PreviewCanvas from '../components/preview_canvas.vue'

const route = useRoute()
const hallId = route.params.id as string
const selectedId = ref<string | null>(null)
const atlasError = ref('')

const hall = computed(() => editorStore.state.hall)
const selected = computed(() => hall.value?.objects.find((o) => o.id === selectedId.value) ?? null)

const kindLabels: Record<ObjectKind, string> = {
  wall: '墙体',
  ceiling: '吊顶',
  floor: '地面',
  cabinet: '展柜',
  stand: '展台',
  vase: '瓷瓶',
  ding: '青铜鼎',
  scroll: '书画卷轴',
}

const atlasReport = computed(() => {
  if (!hall.value) return null
  try {
    const scene = buildSceneGeometry(hall.value)
    const report = buildLightmapAtlas(hall.value, scene)
    atlasError.value = ''
    return report
  } catch (err) {
    atlasError.value = (err as Error).message
    return null
  }
})

const addableKinds: Array<{ kind: ObjectKind; label: string; defaultSize: SceneObject['size'] }> = [
  { kind: 'cabinet', label: '展柜', defaultSize: [1.6, 2.2, 1.6] },
  { kind: 'stand', label: '展台', defaultSize: [1.2, 0.7, 1.2] },
  { kind: 'vase', label: '瓷瓶', defaultSize: [0.55, 0.9, 0.55] },
  { kind: 'ding', label: '青铜鼎', defaultSize: [0.7, 0.8, 0.7] },
  { kind: 'scroll', label: '书画卷轴', defaultSize: [0.9, 1.6, 0.05] },
]

let seq = 0
function addObject(kind: ObjectKind, defaultSize: SceneObject['size']): void {
  if (!hall.value) return
  seq += 1
  const obj: SceneObject = {
    id: `${kind}_${Date.now().toString(36)}_${seq}`,
    name: `${kindLabels[kind]} ${hall.value.objects.filter((o) => o.kind === kind).length + 1}`,
    kind,
    position: [(Math.random() - 0.5) * 4, kind === 'scroll' ? 1.6 : defaultSize[1] / 2, (Math.random() - 0.5) * 4],
    rotationY: 0,
    size: [...defaultSize] as SceneObject['size'],
    material: defaultMaterial(kind),
    importance: kind === 'vase' || kind === 'ding' || kind === 'scroll' ? 2 : 1,
  }
  hall.value.objects.push(obj)
  selectedId.value = obj.id
  editorStore.markDirty()
}

function defaultMaterial(kind: ObjectKind): SceneObject['material'] {
  if (kind === 'vase') return { kind: 'ceramic', baseColor: [0.35, 0.6, 0.55], roughness: 0.25, metallic: 0, patternStrength: 0.7 }
  if (kind === 'ding') return { kind: 'bronze', baseColor: [0.36, 0.28, 0.16], roughness: 0.5, metallic: 0.9, patternStrength: 0.7 }
  if (kind === 'scroll') return { kind: 'paper', baseColor: [0.86, 0.82, 0.7], roughness: 0.9, metallic: 0, patternStrength: 0.5 }
  if (kind === 'cabinet') return { kind: 'glass', baseColor: [0.9, 0.9, 0.92], roughness: 0.08, metallic: 0, patternStrength: 0 }
  return { kind: 'matte', baseColor: [0.6, 0.58, 0.54], roughness: 0.85, metallic: 0, patternStrength: 0 }
}

function removeSelected(): void {
  if (!hall.value || !selected.value) return
  const protectedKinds: ObjectKind[] = ['wall', 'ceiling', 'floor']
  if (protectedKinds.includes(selected.value.kind)) {
    appStore.notify('warning', '建筑主体不允许删除，只能调整参数')
    return
  }
  hall.value.objects = hall.value.objects.filter((o) => o.id !== selected.value?.id)
  selectedId.value = null
  editorStore.markDirty()
}

async function save(): Promise<void> {
  await editorStore.persist(true)
  appStore.notify('success', '布展方案已保存，场景版本号已递增，增量烘焙将基于此版本判定')
}

watch(selectedId, () => {})

onMounted(async () => {
  const hallDoc = await editorStore.load(hallId)
  if (!hallDoc) {
    appStore.notify('error', '展厅不存在或已被删除')
    return
  }
  appStore.setActiveHall(hallId)
  selectedId.value = hallDoc.objects[0]?.id ?? null
})
</script>

<template>
  <div v-if="hall" class="editor-page">
    <SubNavigation :hall-id="hallId" />
    <div class="editor-body">
      <div class="editor-main flex flex-col gap-4">
        <UiPanel title="三维布展预览" description="参数化墙体、展柜与程序展品共用一套几何，预览即烘焙几何">
          <PreviewCanvas :hall="hall" :height="460" />
        </UiPanel>

        <UiPanel title="光照贴图 UV 与图集打包" description="按表面积和重要度自动分配纹素密度，展品密度高于地面">
          <div v-if="atlasReport" class="atlas-stats">
            <div class="stat-item">
              <span class="stat-label">图集尺寸</span>
              <span class="stat-value">{{ atlasReport.size }} × {{ atlasReport.size }} px</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Chart 数量</span>
              <span class="stat-value">{{ atlasReport.charts.length }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">打包利用率</span>
              <span class="stat-value" :style="{ color: atlasReport.utilization > 0.75 ? 'var(--success)' : 'var(--warning)' }">
                {{ (atlasReport.utilization * 100).toFixed(1) }}%
              </span>
            </div>
            <div class="stat-item">
              <span class="stat-label">浪费纹素</span>
              <span class="stat-value">{{ atlasReport.wastedPx.toLocaleString() }} px</span>
            </div>
          </div>
          <div v-else class="atlas-error">{{ atlasError }}</div>
          <div v-if="atlasReport" class="chart-table-wrap">
            <table class="chart-table">
              <thead>
                <tr>
                  <th>Chart</th>
                  <th>尺寸</th>
                  <th>面积 m²</th>
                  <th>纹素密度</th>
                  <th>重要度权重</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="chart in atlasReport.charts.slice(0, 12)" :key="chart.id">
                  <td>{{ chart.id }}</td>
                  <td>{{ chart.widthPx }} × {{ chart.heightPx }}</td>
                  <td>{{ chart.areaM2.toFixed(2) }}</td>
                  <td>{{ chart.texelDensity.toFixed(0) }} tx/m</td>
                  <td>×{{ chart.importanceWeight.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="atlasReport.charts.length > 12" class="table-more">
              其余 {{ atlasReport.charts.length - 12 }} 个 chart 在烘焙检查页查看
            </div>
          </div>
        </UiPanel>
      </div>

      <aside class="editor-side flex flex-col gap-4">
        <UiPanel title="添加物体">
          <div class="add-grid">
            <UiButton v-for="item in addableKinds" :key="item.kind" size="sm" @click="addObject(item.kind, item.defaultSize)">
              + {{ item.label }}
            </UiButton>
          </div>
        </UiPanel>

        <UiPanel title="物体参数">
          <div v-if="!selected" class="muted-text">从下方列表选择物体进行编辑</div>
          <div v-else class="prop-form">
            <div class="prop-row">
              <span class="prop-label">名称</span>
              <input v-model="selected.name" class="prop-input" @change="editorStore.markDirty()" />
            </div>
            <div class="prop-row">
              <span class="prop-label">类型</span>
              <span class="prop-value">{{ kindLabels[selected.kind] }}</span>
            </div>
            <div v-for="(axis, idx) in (['X', 'Y', 'Z'] as const)" :key="`p${axis}`" class="prop-row">
              <span class="prop-label">位置 {{ axis }}</span>
              <input v-model.number="selected.position[idx]" type="number" step="0.1" class="prop-input" @change="editorStore.markDirty()" />
            </div>
            <div class="prop-row">
              <span class="prop-label">旋转 Y°</span>
              <input v-model.number="selected.rotationY" type="number" step="5" class="prop-input" @change="editorStore.markDirty()" />
            </div>
            <div v-for="(axis, idx) in (['宽', '高', '深'] as const)" :key="`s${axis}`" class="prop-row">
              <span class="prop-label">尺寸 {{ axis }}</span>
              <input v-model.number="selected.size[idx]" type="number" step="0.05" min="0.1" class="prop-input" @change="editorStore.markDirty()" />
            </div>
            <div class="prop-row">
              <span class="prop-label">重要度</span>
              <input v-model.number="selected.importance" type="number" step="0.1" min="0.1" class="prop-input" @change="editorStore.markDirty()" />
            </div>
            <div class="prop-row">
              <span class="prop-label">粗糙度</span>
              <input v-model.number="selected.material.roughness" type="number" step="0.05" min="0" max="1" class="prop-input" @change="editorStore.markDirty()" />
            </div>
            <div class="prop-row">
              <span class="prop-label">金属度</span>
              <input v-model.number="selected.material.metallic" type="number" step="0.05" min="0" max="1" class="prop-input" @change="editorStore.markDirty()" />
            </div>
            <UiButton variant="danger" size="sm" @click="removeSelected">删除该物体</UiButton>
          </div>
        </UiPanel>

        <UiPanel title="场景物体">
          <div class="object-list">
            <button
              v-for="obj in hall.objects"
              :key="obj.id"
              class="object-item"
              :class="{ active: obj.id === selectedId }"
              @click="selectedId = obj.id"
            >
              <span>{{ obj.name }}</span>
              <span class="object-kind">{{ kindLabels[obj.kind] }}</span>
            </button>
          </div>
        </UiPanel>

        <UiButton variant="primary" @click="save">保存布展方案</UiButton>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.editor-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.editor-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  overflow: auto;
}
.editor-side {
  min-width: 0;
}
.add-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-2);
}
.atlas-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-3);
}
.stat-item {
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.stat-label {
  color: var(--text-muted);
}
.stat-value {
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
}
.atlas-error {
  color: var(--danger);
  background: rgba(248, 113, 113, 0.1);
  padding: var(--sp-3);
  border-radius: var(--radius-sm);
}
.chart-table-wrap {
  overflow-x: auto;
}
.chart-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-xs);
}
.chart-table th,
.chart-table td {
  text-align: left;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-color);
}
.chart-table th {
  color: var(--text-muted);
  font-weight: var(--fw-medium);
}
.table-more {
  color: var(--text-muted);
  padding: var(--sp-2) 0;
}
.prop-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.prop-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.prop-label {
  width: 72px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.prop-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
  color: var(--text-primary);
}
.prop-input:focus {
  outline: none;
  border-color: var(--primary-500);
}
.prop-value {
  color: var(--text-primary);
}
.muted-text {
  color: var(--text-muted);
}
.object-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  max-height: 260px;
  overflow-y: auto;
}
.object-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  text-align: left;
  transition: background var(--t-fast);
}
.object-item:hover {
  background: var(--bg-inset);
}
.object-item.active {
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.4);
  color: var(--primary-300);
}
.object-kind {
  color: var(--text-muted);
  font-size: var(--fs-xs);
}
</style>
