<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { HallDoc } from '../core/types'
import { createHallFromTemplate, hallRepository } from '../core/storage/hall_repository'
import UiButton from '../components/ui_button.vue'
import UiPanel from '../components/ui_panel.vue'
import EmptyState from '../components/empty_state.vue'
import { appStore } from '../stores/app_store'

const router = useRouter()
const halls = ref<HallDoc[]>([])
const loading = ref(true)
const newName = ref('')

async function refresh(): Promise<void> {
  loading.value = true
  halls.value = await hallRepository.list()
  loading.value = false
}

async function createHall(): Promise<void> {
  const name = newName.value.trim() || `特展展厅 ${halls.value.length + 1}`
  const hall = createHallFromTemplate(name)
  await hallRepository.save(hall)
  appStore.notify('success', `展厅「${name}」已创建，已内置参数化展柜与展品`)
  newName.value = ''
  await refresh()
  await openHall(hall.id)
}

async function openHall(id: string): Promise<void> {
  appStore.setActiveHall(id)
  await router.push(`/editor/${id}`)
}

async function removeHall(hall: HallDoc, event: Event): Promise<void> {
  event.stopPropagation()
  if (!window.confirm(`确认删除展厅「${hall.name}」？烘焙记录与贴图会一并清除。`)) return
  await hallRepository.remove(hall.id)
  appStore.notify('info', `展厅「${hall.name}」已删除`)
  await refresh()
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

onMounted(refresh)
</script>

<template>
  <div class="page-pad flex flex-col gap-5">
    <UiPanel title="新建展厅" description="按墙、吊顶、展柜、展台参数化搭建，模板内置瓷瓶、青铜鼎与书画卷轴展品">
      <div class="create-row">
        <input v-model="newName" class="name-input" placeholder="输入展厅名称，留空自动命名" @keyup.enter="createHall" />
        <UiButton variant="primary" @click="createHall">创建展厅</UiButton>
      </div>
    </UiPanel>

    <UiPanel title="展厅列表" :description="`共 ${halls.length} 个展厅，方案与烘焙结果均保存在本机 IndexedDB`">
      <EmptyState v-if="!loading && halls.length === 0" title="还没有展厅" subtitle="先建一个参数化模板厅，开箱即可布展与烘焙">
        <UiButton variant="primary" @click="createHall">创建第一个展厅</UiButton>
      </EmptyState>

      <div v-else class="hall-grid">
        <article v-for="hall in halls" :key="hall.id" class="hall-card" @click="openHall(hall.id)">
          <div class="hall-card-head">
            <div>
              <div class="hall-name">{{ hall.name }}</div>
              <div class="hall-meta">{{ hall.objects.length }} 个物体 · {{ hall.lights.length }} 盏灯 · 方案 v{{ hall.sceneVersion }}</div>
            </div>
            <span class="bake-badge" :class="hall.lastBakeId ? 'done' : 'pending'">
              {{ hall.lastBakeId ? '已烘焙' : '未烘焙' }}
            </span>
          </div>
          <div class="hall-dims">净尺寸 {{ hall.dimensions[0] }} × {{ hall.dimensions[2] }} × {{ hall.dimensions[1] }} m</div>
          <div class="hall-card-foot">
            <span class="time-text">更新于 {{ formatTime(hall.updatedAt) }}</span>
            <UiButton variant="danger" size="sm" @click="removeHall(hall, $event)">删除</UiButton>
          </div>
        </article>
      </div>
    </UiPanel>
  </div>
</template>

<style scoped>
.page-pad {
  padding: var(--sp-5);
}
.create-row {
  display: flex;
  gap: var(--sp-3);
}
.name-input {
  flex: 1;
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-primary);
}
.name-input:focus {
  outline: none;
  border-color: var(--primary-500);
}
.hall-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--sp-4);
}
.hall-card {
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  cursor: pointer;
  transition: border-color var(--t-fast), transform var(--t-fast);
}
.hall-card:hover {
  border-color: var(--primary-500);
  transform: translateY(-2px);
}
.hall-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-3);
}
.hall-name {
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
}
.hall-meta {
  color: var(--text-muted);
  margin-top: var(--sp-1);
}
.bake-badge {
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
.bake-badge.done {
  background: rgba(52, 211, 153, 0.12);
  color: var(--success);
}
.bake-badge.pending {
  background: rgba(251, 191, 36, 0.12);
  color: var(--warning);
}
.hall-dims {
  color: var(--text-secondary);
}
.hall-card-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid var(--border-color);
  padding-top: var(--sp-3);
}
.time-text {
  color: var(--text-muted);
}
</style>
