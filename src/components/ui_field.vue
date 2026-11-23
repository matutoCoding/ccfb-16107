<script setup lang="ts">
defineProps<{ label: string; hint?: string }>()
</script>

<template>
  <label class="field">
    <span class="field-label">{{ label }}</span>
    <input v-bind="$attrs" class="field-input" />
    <span v-if="hint" class="field-hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.field-label {
  color: var(--text-secondary);
  font-size: var(--fs-xs);
}
.field-input {
  background: var(--bg-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-primary);
  transition: border-color var(--t-fast);
  min-width: 0;
}
.field-input:focus {
  outline: none;
  border-color: var(--primary-500);
}
.field-hint {
  color: var(--text-muted);
  font-size: var(--fs-xs);
}
</style>
