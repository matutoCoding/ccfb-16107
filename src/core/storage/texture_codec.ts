import type { BakeChannelName } from '../types'
import type { StoredTexture } from './hall_repository'

// 把入库的 webp 通道解码回 Float32Array（0~1 近似线性），检查页与增量回读共用
export async function decodeTextureChannels(
  texture: StoredTexture,
  size: number,
): Promise<Record<BakeChannelName, Float32Array>> {
  const channels: Record<BakeChannelName, Float32Array> = {
    direct: new Float32Array(size * size * 3),
    indirect: new Float32Array(size * size * 3),
    ao: new Float32Array(size * size * 3),
  }
  for (const key of ['direct', 'indirect', 'ao'] as const) {
    const blob = texture.blobs[key]
    if (!blob) continue
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    ctx.drawImage(bitmap, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    for (let i = 0; i < size * size; i++) {
      channels[key][i * 3] = data[i * 4] / 255
      channels[key][i * 3 + 1] = data[i * 4 + 1] / 255
      channels[key][i * 3 + 2] = data[i * 4 + 2] / 255
    }
    bitmap.close()
  }
  return channels
}

// Float32 像素绘制到指定 canvas，支持热力图模式
export function paintPixels(
  canvas: HTMLCanvasElement,
  pixels: Float32Array,
  size: number,
  heat = false,
): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
  const image = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    if (heat) {
      image.data[i * 4] = Math.round(pixels[i * 3] * 255)
      image.data[i * 4 + 1] = Math.round(pixels[i * 3 + 1] * 255)
      image.data[i * 4 + 2] = Math.round(pixels[i * 3 + 2] * 255)
    } else {
      image.data[i * 4] = Math.round(Math.min(255, pixels[i * 3] * 255))
      image.data[i * 4 + 1] = Math.round(Math.min(255, pixels[i * 3 + 1] * 255))
      image.data[i * 4 + 2] = Math.round(Math.min(255, pixels[i * 3 + 2] * 255))
    }
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
}
