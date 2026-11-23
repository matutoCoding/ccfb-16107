import type { IesProfile } from './types'
import { makeLcg } from './math3d'

// 解析 IES LM-63 文本，取主垂直角序列与第一条水平角光强曲线
export function parseIes(name: string, text: string): IesProfile {
  const tokens = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const tiltIndex = tokens.findIndex((t) => t.startsWith('TILT='))
  if (tiltIndex < 0) throw new Error('非法 IES 文件：缺少 TILT 段')

  // LM-63 标头 10 个数：灯数/流明/乘数/垂直角数/水平角数/光度类型/单位/宽/长/高
  let cursor = tiltIndex + 1
  const verticalCount = Number(tokens[cursor + 3])
  const horizontalCount = Number(tokens[cursor + 4])
  cursor += 10

  const angles: number[] = []
  for (let i = 0; i < verticalCount; i++) {
    angles.push(Number(tokens[cursor++]))
  }
  // 水平角通常只有一条（旋转对称灯），跳过角度序列只取第一组光强
  const horizontalAngles: number[] = []
  for (let i = 0; i < horizontalCount; i++) {
    horizontalAngles.push(Number(tokens[cursor++]))
  }
  const candelaRaw: number[] = []
  for (let i = 0; i < verticalCount * horizontalCount; i++) {
    candelaRaw.push(Number(tokens[cursor++]))
  }

  const maxCandela = Math.max(...candelaRaw.slice(0, verticalCount), 1e-6)
  return {
    id: `ies_${Math.abs(hashString(name))}`,
    name,
    angles: new Float32Array(angles),
    candela: new Float32Array(candelaRaw.slice(0, verticalCount).map((v) => v / maxCandela)),
  }
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h
}

// IES 查表：入射角（度）-> 归一化光强
export function sampleIes(profile: IesProfile, angleDeg: number): number {
  const { angles, candela } = profile
  if (angleDeg <= angles[0]) return candela[0]
  if (angleDeg >= angles[angles.length - 1]) return candela[candela.length - 1]
  for (let i = 0; i < angles.length - 1; i++) {
    if (angleDeg >= angles[i] && angleDeg <= angles[i + 1]) {
      const t = (angleDeg - angles[i]) / (angles[i + 1] - angles[i] || 1)
      return candela[i] + (candela[i + 1] - candela[i]) * t
    }
  }
  return 0
}

// 在单位半球按余弦权重采样方向，返回方向与 pdf
export function sampleCosineHemisphere(normal: number[], rng: () => number): { dir: number[]; pdf: number } {
  const r1 = rng()
  const r2 = rng()
  const phi = 2 * Math.PI * r1
  const r = Math.sqrt(r2)
  const localX = r * Math.cos(phi)
  const localY = Math.sqrt(Math.max(0, 1 - r2))
  const localZ = r * Math.sin(phi)
  const frame = tangentFrame(normal)
  const dir = [
    frame.t[0] * localX + normal[0] * localY + frame.b[0] * localZ,
    frame.t[1] * localX + normal[1] * localY + frame.b[1] * localZ,
    frame.t[2] * localX + normal[2] * localY + frame.b[2] * localZ,
  ]
  return { dir, pdf: localY / Math.PI }
}

export function tangentFrame(normal: number[]): { t: number[]; b: number[] } {
  const helper = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const t = normalize3(cross3(helper, normal))
  const b = cross3(normal, t)
  return { t, b }
}

export function normalize3(v: number[]): number[] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

export function cross3(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

// 测试用采样入口，烘焙器内部有独立实现
export const rngForTest = makeLcg
