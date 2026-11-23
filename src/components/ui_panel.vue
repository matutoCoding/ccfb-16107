<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h3 class="panel-title">{{ title }}</h3>
      <p v-if="description" class="panel-desc">{{ description }}</p>
    </header>
    <div class="panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
}
.panel-header {
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
  border-bottom: 1px solid var(--border-color);
}
.panel-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
}
.panel-desc {
  margin: var(--sp-1) 0 0;
  color: var(--text-muted);
  font-size: var(--fs-xs);
}
.panel-body {
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
</style>
