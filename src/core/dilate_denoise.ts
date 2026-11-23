import type { BakeChannelName, ChartMeta, Vec3 } from './types'
import { v3 } from './math3d'

// chart 间隙像素标记：三通道全 0 且 AO 为 0 视为无效纹素
function isValid(channel: Float32Array, index: number): boolean {
  return channel[index * 3] !== 0 || channel[index * 3 + 1] !== 0 || channel[index * 3 + 2] !== 0
}

// 边缘膨胀：把最近有效纹素颜色填进间隙，距离按设置半径限制
// 多轮 3x3 扩散实现，复杂度 O(半径 * 像素数)，满足 4~8px 常规需求
export function dilateAtlas(channels: Record<BakeChannelName, Float32Array>, size: number, radius: number): void {
  const total = size * size
  const validMask = new Uint8Array(total)
  for (let i = 0; i < total; i++) validMask[i] = isValid(channels.direct, i) ? 1 : 0
  const maskWork = new Uint8Array(validMask)

  for (let round = 0; round < radius; round++) {
    const snapshot = {
      direct: channels.direct.slice(),
      indirect: channels.indirect.slice(),
      ao: channels.ao.slice(),
    }
    const maskSnapshot = maskWork.slice()
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const idx = y * size + x
        if (maskSnapshot[idx]) continue
        // 找最近有效邻居，按距离加权
        let accR = 0
        let accG = 0
        let accB = 0
        let weight = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nIdx = (y + dy) * size + (x + dx)
            if (!maskSnapshot[nIdx]) continue
            const w = 1 / (Math.hypot(dx, dy) + 0.2)
            for (const key of ['direct', 'indirect', 'ao'] as const) {
              accR += snapshot[key][nIdx * 3] * w
              accG += snapshot[key][nIdx * 3 + 1] * w
              accB += snapshot[key][nIdx * 3 + 2] * w
            }
            weight += w
          }
        }
        if (weight <= 0) continue
        for (const key of ['direct', 'indirect', 'ao'] as const) {
          channels[key][idx * 3] = accR / weight
          channels[key][idx * 3 + 1] = accG / weight
          channels[key][idx * 3 + 2] = accB / weight
        }
        maskWork[idx] = 1
      }
    }
  }
}

interface GBufferMeta {
  // 逐纹素法线与物体 id，用于降噪权重，烘焙时同步生成
  normals: Float32Array
  objectIds: Int32Array
}

// a-trous 边缘保持降噪：波核随迭代步长扩大，法线/深度/亮度差异降权
// 阴影边缘与展品纹饰因为 G-buffer 不连续被保护，不会被抹平
export function denoiseAtlas(
  channels: Record<BakeChannelName, Float32Array>,
  gbuffer: GBufferMeta,
  size: number,
  iterations = 3,
): Record<BakeChannelName, Float32Array> {
  const output: Record<BakeChannelName, Float32Array> = {
    direct: channels.direct.slice(),
    indirect: channels.indirect.slice(),
    ao: channels.ao.slice(),
  }
  const B = [0.25, 0.125, 0.0625] // 中心、轴向、角点权重
  const stepOffset = [
    [0, 0, B[0]],
    [1, 0, B[1]],
    [-1, 0, B[1]],
    [0, 1, B[1]],
    [0, -1, B[1]],
    [1, 1, B[2]],
    [1, -1, B[2]],
    [-1, 1, B[2]],
    [-1, -1, B[2]],
  ]

  for (const key of ['direct', 'indirect'] as const) {
    let src = channels[key].slice()
    for (let iter = 0; iter < iterations; iter++) {
      const stepSize = 1 << iter
      const dst = new Float32Array(src.length)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const idx = y * size + x
          let weightSum = 0
          let r = 0
          let g = 0
          let b = 0
          const centerNormal: Vec3 = [gbuffer.normals[idx * 3], gbuffer.normals[idx * 3 + 1], gbuffer.normals[idx * 3 + 2]]
          const centerLum = src[idx * 3] * 0.2126 + src[idx * 3 + 1] * 0.7152 + src[idx * 3 + 2] * 0.0722
          for (const [ox, oy, baseW] of stepOffset) {
            const nx = x + (ox as number) * stepSize
            const ny = y + (oy as number) * stepSize
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
            const nIdx = ny * size + nx
            if (gbuffer.objectIds[nIdx] !== gbuffer.objectIds[idx]) continue
            const nNormal: Vec3 = [gbuffer.normals[nIdx * 3], gbuffer.normals[nIdx * 3 + 1], gbuffer.normals[nIdx * 3 + 2]]
            const normalWeight = Math.max(0, v3.dot(centerNormal, nNormal))
            const nLum = src[nIdx * 3] * 0.2126 + src[nIdx * 3 + 1] * 0.7152 + src[nIdx * 3 + 2] * 0.0722
            const lumWeight = Math.exp(-Math.abs(centerLum - nLum) * 2.5)
            const w = (baseW as number) * normalWeight * lumWeight
            r += src[nIdx * 3] * w
            g += src[nIdx * 3 + 1] * w
            b += src[nIdx * 3 + 2] * w
            weightSum += w
          }
          if (weightSum <= 0) {
            dst[idx * 3] = src[idx * 3]
            dst[idx * 3 + 1] = src[idx * 3 + 1]
            dst[idx * 3 + 2] = src[idx * 3 + 2]
          } else {
            dst[idx * 3] = r / weightSum
            dst[idx * 3 + 1] = g / weightSum
            dst[idx * 3 + 2] = b / weightSum
          }
        }
      }
      src = dst
    }
    output[key] = src
  }
  return output
}

// 交接处连续性检查所需：chart 边界纹素与相邻 chart 对应纹素的色差
export function chartEdgeColor(channels: Record<BakeChannelName, Float32Array>, chart: ChartMeta, size: number): number[] {
  const composed = new Float32Array(channels.direct.length)
  for (let i = 0; i < composed.length; i += 3) {
    composed[i] = channels.direct[i] + channels.indirect[i]
    composed[i + 1] = channels.direct[i + 1] + channels.indirect[i + 1]
    composed[i + 2] = channels.direct[i + 2] + channels.indirect[i + 2]
  }
  const samples: number[] = []
  for (let x = chart.x; x < chart.x + chart.widthPx; x++) {
    const idx = chart.y * size + x
    samples.push(composed[idx * 3], composed[idx * 3 + 1], composed[idx * 3 + 2])
  }
  return samples
}
