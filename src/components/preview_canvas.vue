<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { HallDoc, Vec3 } from '../core/types'
import { buildSceneGeometry } from '../core/geometry/geometry_builder'
import { CanvasPreviewRenderer, type OrbitCamera, type PreviewOverlay } from '../core/renderer/canvas_preview_renderer'
import { degToRad } from '../core/math3d'

const props = defineProps<{
  hall: HallDoc
  overlay?: PreviewOverlay
  height?: number
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const renderer = new CanvasPreviewRenderer()
const camera = ref<OrbitCamera>({
  target: [0, 1.4, 0],
  yaw: 0.6,
  pitch: 0.32,
  distance: 14,
  fovYRad: degToRad(55),
})

let dragging = false
let lastX = 0
let lastY = 0

function draw(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const scene = buildSceneGeometry(props.hall)
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
    canvas.width = cssWidth * dpr
    canvas.height = cssHeight * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  renderer.render(ctx, {
    hall: props.hall,
    scene,
    camera: camera.value,
    overlay: props.overlay,
    width: cssWidth,
    height: cssHeight,
  })
}

function onPointerDown(e: PointerEvent): void {
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  camera.value.yaw -= dx * 0.008
  camera.value.pitch = Math.max(-0.2, Math.min(1.2, camera.value.pitch + dy * 0.008))
  draw()
}

function onPointerUp(): void {
  dragging = false
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  camera.value.distance = Math.max(4, Math.min(30, camera.value.distance + e.deltaY * 0.01))
  draw()
}

function resetCamera(): void {
  camera.value = { target: [0, 1.4, 0], yaw: 0.6, pitch: 0.32, distance: 14, fovYRad: degToRad(55) }
  draw()
}

// 发布预览展线巡览用：外部直接指定相机状态
function moveCamera(next: OrbitCamera): void {
  camera.value = next
  draw()
}

defineExpose({ resetCamera, draw, moveCamera })

onMounted(() => {
  draw()
  window.addEventListener('resize', draw)
})
onBeforeUnmount(() => window.removeEventListener('resize', draw))
watch(() => props.hall, draw, { deep: true })
watch(() => props.overlay, draw, { deep: true })
</script>

<template>
  <div class="preview-canvas-wrap" :style="{ height: `${height ?? 520}px` }">
    <canvas
      ref="canvasRef"
      class="preview-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerUp"
      @wheel="onWheel"
    />
    <div class="preview-hint">拖拽旋转视角 · 滚轮缩放</div>
  </div>
</template>

<style scoped>
.preview-canvas-wrap {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--slate-950);
}
.preview-canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
  touch-action: none;
}
.preview-canvas:active {
  cursor: grabbing;
}
.preview-hint {
  position: absolute;
  left: var(--sp-3);
  bottom: var(--sp-3);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-sm);
  background: rgba(8, 13, 24, 0.72);
  color: var(--text-muted);
  font-size: var(--fs-xs);
  pointer-events: none;
}
</style>
