import { reactive } from 'vue'
import type { HallDoc } from '../core/types'
import { hallRepository } from '../core/storage/hall_repository'

// 当前厅的编辑态：所有编辑页面共享同一份内存数据，切页不丢
interface EditorState {
  hall: HallDoc | null
  loading: boolean
  dirty: boolean
}

const state = reactive<EditorState>({ hall: null, loading: false, dirty: false })

export const editorStore = {
  state,

  async load(id: string): Promise<HallDoc | null> {
    state.loading = true
    try {
      const hall = await hallRepository.get(id)
      state.hall = hall ?? null
      state.dirty = false
      return state.hall
    } finally {
      state.loading = false
    }
  },

  current(): HallDoc {
    if (!state.hall) throw new Error('编辑厅未加载')
    return state.hall
  },

  markDirty(): void {
    state.dirty = true
  },

  async persist(bumpVersion = false): Promise<void> {
    if (!state.hall) return
    if (bumpVersion) state.hall.sceneVersion += 1
    await hallRepository.save(state.hall)
    state.dirty = false
  },

  unload(): void {
    state.hall = null
    state.dirty = false
  },
}
