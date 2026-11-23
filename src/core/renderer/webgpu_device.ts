// WebGPU 能力探测与上下文初始化，不可用时由上层切到 2D 兜底
export interface GpuCapability {
  supported: boolean
  adapter: GPUAdapter | null
  device: GPUDevice | null
  reason: string
}

export async function detectWebGpu(): Promise<GpuCapability> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { supported: false, adapter: null, device: null, reason: '当前浏览器不支持 WebGPU' }
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return { supported: false, adapter: null, device: null, reason: '未找到可用 GPU 适配器' }
    const device = await adapter.requestDevice()
    device.lost.then((info) => {
      console.warn('WebGPU device lost:', info.message)
    })
    return { supported: true, adapter, device, reason: 'ok' }
  } catch (err) {
    return { supported: false, adapter: null, device: null, reason: `WebGPU 初始化失败：${(err as Error).message}` }
  }
}

// 烘焙纹理在 GPU 与 CPU 间传递的统一描述
export interface GpuTextureHandle {
  texture: GPUTexture
  width: number
  height: number
}

export async function uploadFloatTexture(device: GPUDevice, pixels: Float32Array, size: number): Promise<GpuTextureHandle> {
  const texture = device.createTexture({
    size: { width: size, height: size },
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  // 补齐 alpha 通道
  const rgba = new Float32Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = pixels[i * 3]
    rgba[i * 4 + 1] = pixels[i * 3 + 1]
    rgba[i * 4 + 2] = pixels[i * 3 + 2]
    rgba[i * 4 + 3] = 1
  }
  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow: size * 16, rowsPerImage: size },
    { width: size, height: size },
  )
  return { texture, width: size, height: size }
}
