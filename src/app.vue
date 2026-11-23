<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router'
import { computed } from 'vue'
import { appStore } from './stores/app_store'
import { detectWebGpu } from './core/renderer/webgpu_device'

const route = useRoute()
const pageTitle = computed(() => (route.meta.title as string) ?? '虚拟展厅烘焙系统')

const toastStyles: Record<string, string> = {
  info: 'background: var(--slate-800); color: var(--text-primary); border: 1px solid var(--border-color)',
  success: 'background: rgba(52,211,153,0.15); color: var(--success); border: 1px solid rgba(52,211,153,0.4)',
  warning: 'background: rgba(251,191,36,0.15); color: var(--warning); border: 1px solid rgba(251,191,36,0.4)',
  error: 'background: rgba(248,113,113,0.15); color: var(--danger); border: 1px solid rgba(248,113,113,0.4)',
}
const toastClass = computed(() => (appStore.state.toast ? toastStyles[appStore.state.toast.type] : ''))

detectWebGpu().then((cap) => appStore.setGpu(cap))
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header
      class="h-14 flex items-center gap-4 px-6 border-b shrink-0"
      style="border-color: var(--border-color); background: var(--bg-panel)"
    >
      <div class="flex items-center gap-3">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background: var(--primary-600)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />
          </svg>
        </div>
        <div style="font-size: var(--fs-base); font-weight: var(--fw-semibold)">虚拟展厅布展与光照烘焙系统</div>
      </div>
      <div class="ml-auto flex items-center gap-4" style="color: var(--text-secondary); font-size: var(--fs-xs)">
        <span>{{ pageTitle }}</span>
        <span
          class="px-2 py-1 rounded-md"
          :style="{
            background: appStore.state.gpu?.supported ? 'rgba(52,211,153,0.12)' : 'rgba(251,191,36,0.12)',
            color: appStore.state.gpu?.supported ? 'var(--success)' : 'var(--warning)',
          }"
        >
          {{ appStore.state.gpu ? (appStore.state.gpu.supported ? 'WebGPU 已就绪' : 'CPU 兼容模式') : '检测渲染后端中' }}
        </span>
      </div>
    </header>

    <main class="flex-1 flex flex-col min-h-0">
      <RouterView />
    </main>

    <Transition name="toast">
      <div v-if="appStore.state.toast" class="fixed right-6 bottom-6 z-50 px-4 py-3 rounded-lg shadow-lg" :style="toastClass">
        {{ appStore.state.toast.text }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--t), transform var(--t);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
