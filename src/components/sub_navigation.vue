<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { computed } from 'vue'

const props = defineProps<{ hallId: string }>()
const route = useRoute()

const tabs = computed(() => [
  { name: '布展编辑', to: `/editor/${props.hallId}` },
  { name: '灯光设置', to: `/editor/${props.hallId}/lights` },
  { name: '烘焙队列', to: `/editor/${props.hallId}/bake` },
  { name: '烘焙检查', to: `/editor/${props.hallId}/check` },
  { name: '发布预览', to: `/editor/${props.hallId}/publish` },
])
</script>

<template>
  <nav class="sub-nav">
    <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="sub-nav-item" :class="{ active: route.path === tab.to }">
      {{ tab.name }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.sub-nav {
  display: flex;
  gap: var(--sp-1);
  padding: 0 var(--sp-5);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
}
.sub-nav-item {
  padding: var(--sp-3) var(--sp-4);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  transition: color var(--t-fast), border-color var(--t-fast);
}
.sub-nav-item:hover {
  color: var(--text-primary);
}
.sub-nav-item.active {
  color: var(--primary-300);
  border-bottom-color: var(--primary-500);
}
</style>
