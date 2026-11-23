import { reactive, readonly } from 'vue'
import type { GpuCapability } from '../core/renderer/webgpu_device'

interface AppState {
  gpu: GpuCapability | null
  // 当前编辑厅 id，跨页面保持
  activeHallId: string | null
  // 全局提示消息
  toast: { id: number; type: 'info' | 'success' | 'warning' | 'error'; text: string } | null
}

const state = reactive<AppState>({
  gpu: null,
  activeHallId: null,
  toast: null,
})

let toastSeq = 0

export const appStore = {
  state: readonly(state),

  setGpu(capability: GpuCapability): void {
    state.gpu = capability
  },

  setActiveHall(id: string | null): void {
    state.activeHallId = id
  },

  notify(type: 'info' | 'success' | 'warning' | 'error', text: string): void {
    toastSeq += 1
    const id = toastSeq
    state.toast = { id, type, text }
    setTimeout(() => {
      if (state.toast?.id === id) state.toast = null
    }, 3200)
  },
}
