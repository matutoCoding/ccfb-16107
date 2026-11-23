<script setup lang="ts">
defineProps<{ title: string; subtitle: string }>()
</script>

<template>
  <div class="empty-state">
    <div class="empty-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18M3 9h18" />
      </svg>
    </div>
    <div class="empty-title">{{ title }}</div>
    <div class="empty-subtitle">{{ subtitle }}</div>
    <div class="empty-action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--sp-7) var(--sp-5);
  gap: var(--sp-2);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: var(--sp-2);
}
.empty-title {
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
}
.empty-subtitle {
  color: var(--text-muted);
  font-size: var(--fs-xs);
}
.empty-action {
  margin-top: var(--sp-4);
}
</style>
