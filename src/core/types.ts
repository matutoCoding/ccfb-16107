// 虚拟展厅核心领域模型，全管线共享的数据契约

export type Vec3 = [number, number, number]

// 场景物体类别：建筑参数化基元 + 程序生成展品
export type ObjectKind =
  | 'wall'
  | 'ceiling'
  | 'floor'
  | 'cabinet'
  | 'stand'
  | 'vase'
  | 'ding'
  | 'scroll'

export type MaterialKind = 'matte' | 'ceramic' | 'bronze' | 'paper' | 'glass'

export interface MaterialConfig {
  kind: MaterialKind
  baseColor: Vec3 // 线性空间 0~1
  roughness: number
  metallic: number
  // 展品纹饰强度，0 为纯色，>0 时程序生成纹样
  patternStrength: number
}

export interface SceneObject {
  id: string
  name: string
  kind: ObjectKind
  position: Vec3
  // 仅绕 Y 轴旋转，满足布展需求并简化 BVH 重建
  rotationY: number
  // 参数化尺寸（米），不同 kind 读取不同分量
  size: Vec3
  material: MaterialConfig
  // 重要度权重：展品高、地面低，驱动纹素密度分配
  importance: number
}

// 灯光类别
export type LightKind = 'spot' | 'wallwash' | 'linear' | 'skylight'

export interface LightConfig {
  id: string
  name: string
  kind: LightKind
  position: Vec3
  target: Vec3
  color: Vec3
  // 光度强度（流明），IES 导入时按文件归一化
  intensity: number
  // 射灯半光束角（度），其余灯型忽略
  beamAngle: number
  // 线形灯长度（米）
  length: number
  castShadow: boolean
  // 关联的 IES 配光文件 id，空表示余弦配光
  iesProfileId: string | null
}

export interface IesProfile {
  id: string
  name: string
  // 垂直角 -> 归一化光强采样，线性插值查表
  angles: Float32Array
  candela: Float32Array
}

export interface BakeSettings {
  // 图集边长，支持 512/1024/2048
  atlasSize: number
  // 基础纹素密度（纹素/平方米），再乘重要度权重
  baseTexelDensity: number
  samplesPerPixel: number
  bounceCount: number
  // 单次调度处理的 chart 数量，保证主线程时间片可控
  chunkSize: number
  denoise: boolean
  // 膨胀半径（纹素）
  dilationRadius: number
}

// 光照贴图 chart：物体参数表面在图集中的矩形区域
export interface ChartMeta {
  id: string
  objectId: string
  // 同一物体多表面时的表面标签，如 box:top / lathe:side
  surfaceTag: string
  // 图集中的像素矩形
  x: number
  y: number
  widthPx: number
  heightPx: number
  // 真实表面积（平方米）
  areaM2: number
  texelDensity: number
  importanceWeight: number
}

export interface AtlasReport {
  size: number
  charts: ChartMeta[]
  // 打包利用率 0~1
  utilization: number
  wastedPx: number
}

// 烘焙分通道
export type BakeChannelName = 'direct' | 'indirect' | 'ao'

// 增量烘焙的失效原因码
export type InvalidateReason = 'self-moved' | 'shadow-frustum' | 'neighbor-probe' | 'light-changed'

export interface InvalidationEntry {
  chartId: string
  objectId: string
  reasons: InvalidateReason[]
  detail: string
}

export interface BakeRecord {
  id: string
  hallId: string
  // 对应布展方案版本，版本不一致禁止增量
  sceneVersion: number
  atlasSize: number
  channels: BakeChannelName[]
  // 各通道 ImageBitmap 无法直接结构化克隆，纹理单独入库
  startedAt: number
  finishedAt: number
  elapsedMs: number
  sampleCount: number
  bounceCount: number
  // 与参考路径追踪对比的质检指标
  meanError: number
  rmse: number
  psnr: number
  // 增量烘焙审计信息；全量烘焙为空
  incremental: boolean
  invalidations: InvalidationEntry[]
  denoised: boolean
}

export interface HallDoc {
  id: string
  name: string
  // 厅体净尺寸（米）
  dimensions: Vec3
  objects: SceneObject[]
  lights: LightConfig[]
  bakeSettings: BakeSettings
  sceneVersion: number
  createdAt: number
  updatedAt: number
  // 最近一次烘焙记录 id
  lastBakeId: string | null
}

export interface ReflectionProbe {
  id: string
  cabinetObjectId: string
  position: Vec3
  // 立方体贴图边长
  resolution: number
}

export interface PublishPackage {
  id: string
  hallId: string
  tier: 'desktop' | 'mobile'
  totalBytes: number
  // 手机档贴图预算（字节）
  budgetBytes: number
  exportedAt: number
  walkPath: Vec3[]
}

export const DEFAULT_BAKE_SETTINGS: BakeSettings = {
  atlasSize: 1024,
  baseTexelDensity: 96,
  samplesPerPixel: 64,
  bounceCount: 2,
  chunkSize: 2,
  denoise: true,
  dilationRadius: 4,
}
