import type { Vec3 } from './types'

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  normalize(a: Vec3): Vec3 {
    const len = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / len, a[1] / len, a[2] / len]
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  clamp(a: Vec3, lo: number, hi: number): Vec3 {
    return [
      Math.min(hi, Math.max(lo, a[0])),
      Math.min(hi, Math.max(lo, a[1])),
      Math.min(hi, Math.max(lo, a[2])),
    ]
  },
}

// 列主序 4x4，与 WGSL uniform 内存布局一致
export type Mat4 = Float32Array

export const mat4 = {
  identity(): Mat4 {
    const m = new Float32Array(16)
    m[0] = m[5] = m[10] = m[15] = 1
    return m
  },

  multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16)
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3]
      }
    }
    return out
  },

  translation(p: Vec3): Mat4 {
    const m = mat4.identity()
    m[12] = p[0]
    m[13] = p[1]
    m[14] = p[2]
    return m
  },

  rotationY(rad: number): Mat4 {
    const m = mat4.identity()
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    m[0] = c
    m[2] = -s
    m[8] = s
    m[10] = c
    return m
  },

  compose(position: Vec3, rotationY: number): Mat4 {
    return mat4.multiply(mat4.translation(position), mat4.rotationY(rotationY))
  },

  transformPoint(m: Mat4, p: Vec3): Vec3 {
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
    const invW = w || 1
    return [
      (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / invW,
      (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / invW,
      (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / invW,
    ]
  },

  transformDir(m: Mat4, d: Vec3): Vec3 {
    return [
      m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
      m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
      m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
    ]
  },

  invert(m: Mat4): Mat4 {
    const out = new Float32Array(16)
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15]
    const b00 = a00 * a11 - a01 * a10
    const b01 = a00 * a12 - a02 * a10
    const b02 = a00 * a13 - a03 * a10
    const b03 = a01 * a12 - a02 * a11
    const b04 = a01 * a13 - a03 * a11
    const b05 = a02 * a13 - a03 * a12
    const b06 = a20 * a31 - a21 * a30
    const b07 = a20 * a32 - a22 * a30
    const b08 = a20 * a33 - a23 * a30
    const b09 = a21 * a32 - a22 * a31
    const b10 = a21 * a33 - a23 * a31
    const b11 = a22 * a33 - a23 * a32
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
    det = det || 1
    const invDet = 1 / det
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet
    return out
  },
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export const degToRad = (deg: number): number => (deg * Math.PI) / 180

// 线性插值，IES 查表等场景复用
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

// 确定性随机：烘焙分块需要可复现的采样序列
export function makeLcg(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}
