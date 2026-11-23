import type { BakeChannelName, HallDoc, PublishPackage, Vec3 } from './types'
import { channelToImageData, composeChannels, imageDataToBlob } from './texture_utils'

// 手机端总贴图预算 16MB（解码前 webp 体积），桌面端不设硬上限但给目标值
const MOBILE_BUDGET_BYTES = 16 * 1024 * 1024
const DESKTOP_TARGET_BYTES = 48 * 1024 * 1024

export interface PublishOptions {
  tier: 'desktop' | 'mobile'
  channels: Record<BakeChannelName, Float32Array>
  atlasSize: number
}

export interface PublishedTexture {
  blob: Blob
  width: number
  height: number
  bytes: number
}

// 两档压缩：桌面保留图集全尺寸，手机按档缩放并量化
// 手机档若超预算，逐级降分辨率直到卡进 16MB，压缩轨迹写入返回说明
export async function publishTextures(options: PublishOptions): Promise<{
  texture: PublishedTexture
  packageInfo: Omit<PublishPackage, 'id' | 'hallId' | 'exportedAt' | 'walkPath'>
  resizeLog: string[]
}> {
  const { tier, channels, atlasSize } = options
  const resizeLog: string[] = []
  const composed = composeChannels(channels, atlasSize * atlasSize)
  let currentSize = atlasSize
  let blob = await encodeAt(composed, currentSize, tier === 'mobile' ? 0.72 : 0.9)
  resizeLog.push(`${currentSize}px webp 体积 ${formatBytes(blob.size)}`)

  const budget = tier === 'mobile' ? MOBILE_BUDGET_BYTES : DESKTOP_TARGET_BYTES
  while (tier === 'mobile' && blob.size > budget && currentSize > 256) {
    currentSize = Math.floor(currentSize / 2)
    blob = await encodeAt(composed, currentSize, 0.72)
    resizeLog.push(`超出预算，降档至 ${currentSize}px，体积 ${formatBytes(blob.size)}`)
  }

  if (tier === 'mobile' && blob.size > budget) {
    throw new Error(`手机档贴图在 ${currentSize}px 仍超出 ${formatBytes(budget)} 预算，需减少 chart 数量或降低纹素密度`)
  }

  return {
    texture: { blob, width: currentSize, height: currentSize, bytes: blob.size },
    packageInfo: {
      tier,
      totalBytes: blob.size,
      budgetBytes: budget,
    },
    resizeLog,
  }
}

async function encodeAt(pixels: Float32Array, size: number, quality: number): Promise<Blob> {
  const fullSize = Math.sqrt(pixels.length / 3)
  const image = channelToImageData(pixels, fullSize, fullSize)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  const source = document.createElement('canvas')
  source.width = fullSize
  source.height = fullSize
  source.getContext('2d')?.putImageData(image, 0, 0)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, size, size)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('webp 编码失败'))),
      'image/webp',
      quality,
    )
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

// 沿展线生成相机路径：从厅入口起步，依次经过每个展柜/展台，最后到出口
export function buildWalkPath(hall: HallDoc): Vec3[] {
  const [w, , d] = hall.dimensions
  const path: Vec3[] = [[0, 1.55, d / 2 - 0.8]]
  const stops = hall.objects
    .filter((o) => o.kind === 'cabinet' || o.kind === 'stand')
    .sort((a, b) => a.position[2] - b.position[2] || a.position[0] - b.position[0])
  for (const stop of stops) {
    // 相机停在展品正前方 1.2m，与人眼高度对齐
    path.push([stop.position[0], 1.55, stop.position[2] + 1.2])
  }
  path.push([0, 1.55, -d / 2 + 0.8])
  return path
}
