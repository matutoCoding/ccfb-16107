<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; size?: 'sm' | 'md' }>(), {
  variant: 'secondary',
  disabled: false,
  size: 'md',
})
</script>

<template>
  <button class="btn" :class="[`btn-${variant}`, `btn-${size}`]" :disabled="disabled">
    <slot />
  </button>
</template>

<style scoped>
.btn {
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  border: 1px solid transparent;
}
.btn-md {
  padding: var(--sp-2) var(--sp-4);
}
.btn-sm {
  padding: var(--sp-1) var(--sp-3);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--primary-600);
  color: white;
}
.btn-primary:not(:disabled):hover {
  background: var(--primary-500);
}
.btn-secondary {
  background: var(--bg-inset);
  border-color: var(--border-color);
  color: var(--text-primary);
}
.btn-secondary:not(:disabled):hover {
  border-color: var(--primary-500);
  color: var(--primary-300);
}
.btn-danger {
  background: rgba(248, 113, 113, 0.12);
  border-color: rgba(248, 113, 113, 0.4);
  color: var(--danger);
}
.btn-danger:not(:disabled):hover {
  background: rgba(248, 113, 113, 0.22);
}
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
}
.btn-ghost:not(:disabled):hover {
  color: var(--text-primary);
  background: var(--bg-inset);
}
</style>
