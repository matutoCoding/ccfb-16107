import type { BakeChannelName, Vec3 } from './types'

// 线性 HDR -> sRGB 8bit，带软肩压缩防过曝截断
export function hdrToSrgb8(value: number): number {
  const compressed = value / (1 + value * 0.35)
  const linear = Math.min(1, Math.max(0, compressed))
  const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
  return Math.round(srgb * 255)
}

export function channelToImageData(channel: Float32Array, width: number, height: number): ImageData {
  const image = new ImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    image.data[i * 4] = hdrToSrgb8(channel[i * 3])
    image.data[i * 4 + 1] = hdrToSrgb8(channel[i * 3 + 1])
    image.data[i * 4 + 2] = hdrToSrgb8(channel[i * 3 + 2])
    image.data[i * 4 + 3] = 255
  }
  return image
}

// 合成图：直接光 + 间接光，再乘 AO
export function composeChannels(channels: Record<BakeChannelName, Float32Array>, pixelCount: number): Float32Array {
  const out = new Float32Array(pixelCount * 3)
  for (let i = 0; i < pixelCount; i++) {
    const ao = channels.ao[i * 3]
    for (let k = 0; k < 3; k++) {
      out[i * 3 + k] = (channels.direct[i * 3 + k] + channels.indirect[i * 3 + k]) * (0.25 + 0.75 * ao)
    }
  }
  return out
}

// 热力图色带：蓝(低) -> 青 -> 绿 -> 黄 -> 红(高)
const HEAT_STOPS: Array<{ t: number; color: Vec3 }> = [
  { t: 0, color: [0.13, 0.27, 0.9] },
  { t: 0.25, color: [0.1, 0.8, 0.85] },
  { t: 0.5, color: [0.2, 0.85, 0.35] },
  { t: 0.75, color: [0.98, 0.8, 0.15] },
  { t: 1, color: [0.95, 0.2, 0.2] },
]

export function heatColor(t: number): Vec3 {
  const x = Math.min(1, Math.max(0, t))
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    const a = HEAT_STOPS[i]
    const b = HEAT_STOPS[i + 1]
    if (x >= a.t && x <= b.t) {
      const k = (x - a.t) / (b.t - a.t)
      return [
        a.color[0] + (b.color[0] - a.color[0]) * k,
        a.color[1] + (b.color[1] - a.color[1]) * k,
        a.color[2] + (b.color[2] - a.color[2]) * k,
      ]
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1].color
}

export function floatToImageData(pixels: Float32Array, width: number, height: number, heat = false): ImageData {
  const image = new ImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    if (heat) {
      const c = heatColor(pixels[i * 3])
      image.data[i * 4] = Math.round(c[0] * 255)
      image.data[i * 4 + 1] = Math.round(c[1] * 255)
      image.data[i * 4 + 2] = Math.round(c[2] * 255)
    } else {
      image.data[i * 4] = hdrToSrgb8(pixels[i * 3])
      image.data[i * 4 + 1] = hdrToSrgb8(pixels[i * 3 + 1])
      image.data[i * 4 + 2] = hdrToSrgb8(pixels[i * 3 + 2])
    }
    image.data[i * 4 + 3] = 255
  }
  return image
}

export async function imageDataToBlob(image: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.putImageData(image, 0, 0)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas 转 blob 失败'))), 'image/png')
  })
}

export async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(blob)
}

// 等比缩放缩略图，列表页与检查页复用
export async function makeThumbnail(bitmap: ImageBitmap, maxSize: number): Promise<Blob> {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0, w, h)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('缩略图生成失败'))), 'image/webp', 0.82)
  })
}
