import type {
  BakeChannelName,
  BakeRecord,
  HallDoc,
  IesProfile,
  PublishPackage,
  ReflectionProbe,
  SceneObject,
  LightConfig,
} from '../types'
import { DEFAULT_BAKE_SETTINGS } from '../types'
import { idbDelete, idbGet, idbGetAll, idbPut, STORES } from './idb'
import type { SceneSnapshot } from '../incremental_bake'
import { takeSnapshot } from '../incremental_bake'

const HALL_PREFIX = 'hall:'
const BAKE_PREFIX = 'bake:'
const TEXTURE_PREFIX = 'texture:'
const SNAPSHOT_PREFIX = 'snapshot:'

export interface StoredTexture {
  bakeId: string
  hallId: string
  atlasSize: number
  // 分通道 Blob（webp），检查页按通道独立解码
  blobs: Partial<Record<BakeChannelName, Blob>>
  // 未降噪原始通道，用于降噪前后对比
  rawBlobs: Partial<Record<BakeChannelName, Blob>>
  createdAt: number
}

export const hallRepository = {
  async list(): Promise<HallDoc[]> {
    const all = await idbGetAll<HallDoc>(STORES.halls)
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async get(id: string): Promise<HallDoc | undefined> {
    return await idbGet<HallDoc>(STORES.halls, HALL_PREFIX + id)
  },

  async save(hall: HallDoc): Promise<void> {
    hall.updatedAt = Date.now()
    await idbPut(STORES.halls, HALL_PREFIX + hall.id, hall)
  },

  async remove(id: string): Promise<void> {
    await idbDelete(STORES.halls, HALL_PREFIX + id)
  },

  async bumpVersion(hall: HallDoc): Promise<void> {
    hall.sceneVersion += 1
    await this.save(hall)
  },

  async listBakes(hallId: string): Promise<BakeRecord[]> {
    const all = await idbGetAll<BakeRecord>(STORES.bakes)
    return all.filter((b) => b.hallId === hallId).sort((a, b) => b.finishedAt - a.finishedAt)
  },

  async saveBake(record: BakeRecord, texture: StoredTexture): Promise<void> {
    await idbPut(STORES.bakes, BAKE_PREFIX + record.id, record)
    await idbPut(STORES.textures, TEXTURE_PREFIX + record.id, texture)
  },

  async getBake(bakeId: string): Promise<{ record: BakeRecord; texture: StoredTexture } | undefined> {
    const record = await idbGet<BakeRecord>(STORES.bakes, BAKE_PREFIX + bakeId)
    const texture = await idbGet<StoredTexture>(STORES.textures, TEXTURE_PREFIX + bakeId)
    if (!record || !texture) return undefined
    return { record, texture }
  },

  async saveSnapshot(hallId: string, snapshot: SceneSnapshot): Promise<void> {
    await idbPut(STORES.snapshots, SNAPSHOT_PREFIX + hallId, snapshot)
  },

  async getSnapshot(hallId: string): Promise<SceneSnapshot | undefined> {
    return await idbGet<SceneSnapshot>(STORES.snapshots, SNAPSHOT_PREFIX + hallId)
  },

  async saveIes(profile: IesProfile): Promise<void> {
    // Float32Array 结构化克隆可直接入库
    await idbPut(STORES.ies, profile.id, profile)
  },

  async listIes(): Promise<IesProfile[]> {
    return await idbGetAll<IesProfile>(STORES.ies)
  },

  async saveProbes(hallId: string, probes: ReflectionProbe[]): Promise<void> {
    await idbPut(STORES.probes, hallId, probes)
  },

  async getProbes(hallId: string): Promise<ReflectionProbe[]> {
    return (await idbGet<ReflectionProbe[]>(STORES.probes, hallId)) ?? []
  },

  async savePublish(pkg: PublishPackage, blob: Blob): Promise<void> {
    await idbPut(STORES.publishes, pkg.id, { pkg, blob })
  },
}

// 模板厅：四面墙 + 吊顶 + 地面 + 一组默认展柜与射灯，保证开箱即可烘焙
export function createHallFromTemplate(name: string): HallDoc {
  const now = Date.now()
  const id = `hall_${now.toString(36)}`
  const dims: [number, number, number] = [16, 5, 12]
  const objects: SceneObject[] = [
    boxObject(id, 'floor', '地面', [0, -0.05, 0], [dims[0], 0.1, dims[2]], [0.32, 0.3, 0.27], 1),
    boxObject(id, 'ceiling', '吊顶', [0, dims[1], 0], [dims[0], 0.1, dims[2]], [0.85, 0.84, 0.8], 1),
    boxObject(id, 'wall', '北墙', [0, dims[1] / 2, -dims[2] / 2], [dims[0], dims[1], 0.15], [0.78, 0.76, 0.72], 1),
    boxObject(id, 'wall', '南墙', [0, dims[1] / 2, dims[2] / 2], [dims[0], dims[1], 0.15], [0.78, 0.76, 0.72], 1),
    boxObject(id, 'wall', '东墙', [dims[0] / 2, dims[1] / 2, 0], [0.15, dims[1], dims[2]], [0.75, 0.73, 0.7], 1),
    boxObject(id, 'wall', '西墙', [-dims[0] / 2, dims[1] / 2, 0], [0.15, dims[1], dims[2]], [0.75, 0.73, 0.7], 1),
  ]

  // 三个展柜 + 展台 + 程序展品，沿中线排列
  const cabinetXs = [-5, 0, 5]
  cabinetXs.forEach((x, i) => {
    objects.push(boxObject(id, 'cabinet', `展柜${i + 1}`, [x, 1.1, -2], [1.6, 2.2, 1.6], [0.9, 0.9, 0.92], 1, 'glass'))
    objects.push(boxObject(id, 'stand', `展台${i + 1}`, [x, 0.35, -2], [1.2, 0.7, 1.2], [0.4, 0.34, 0.26], 1))
    if (i === 0) {
      objects.push(exhibitObject(id, 'vase', '青瓷瓶', [x, 1.35, -2], [0.55, 0.9, 0.55], [0.35, 0.6, 0.55], 'ceramic'))
    } else if (i === 1) {
      objects.push(exhibitObject(id, 'ding', '青铜鼎', [x, 1.3, -2], [0.7, 0.8, 0.7], [0.36, 0.28, 0.16], 'bronze'))
    } else {
      objects.push(exhibitObject(id, 'scroll', '山水卷轴', [x, 1.6, -2.85], [0.9, 1.6, 0.05], [0.86, 0.82, 0.7], 'paper'))
    }
  })

  const lights: LightConfig[] = cabinetXs.map((x, i) => ({
    id: `${id}_spot_${i}`,
    name: `轨道射灯${i + 1}`,
    kind: 'spot',
    position: [x, 4.6, -1],
    target: [x, 1, -2],
    color: [1, 0.92, 0.8],
    intensity: 2.2,
    beamAngle: 22,
    length: 0,
    castShadow: true,
    iesProfileId: null,
  }))
  lights.push({
    id: `${id}_sky`,
    name: '天窗自然光',
    kind: 'skylight',
    position: [0, 4.8, 2],
    target: [0, 0, 2],
    color: [0.82, 0.9, 1],
    intensity: 1.1,
    beamAngle: 60,
    length: 0,
    castShadow: true,
    iesProfileId: null,
  })

  const hall: HallDoc = {
    id,
    name,
    dimensions: dims,
    objects,
    lights,
    bakeSettings: { ...DEFAULT_BAKE_SETTINGS },
    sceneVersion: 1,
    createdAt: now,
    updatedAt: now,
    lastBakeId: null,
  }
  return hall
}

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

function boxObject(
  hallId: string,
  kind: SceneObject['kind'],
  name: string,
  position: SceneObject['position'],
  size: SceneObject['size'],
  color: SceneObject['material']['baseColor'],
  importance: number,
  materialKind: SceneObject['material']['kind'] = 'matte',
): SceneObject {
  return {
    id: nextId(`${hallId}_${kind}`),
    name,
    kind,
    position,
    rotationY: 0,
    size,
    material: { kind: materialKind, baseColor: color, roughness: materialKind === 'glass' ? 0.08 : 0.85, metallic: materialKind === 'glass' ? 0 : 0, patternStrength: 0 },
    importance,
  }
}

function exhibitObject(
  hallId: string,
  kind: SceneObject['kind'],
  name: string,
  position: SceneObject['position'],
  size: SceneObject['size'],
  color: SceneObject['material']['baseColor'],
  materialKind: SceneObject['material']['kind'],
): SceneObject {
  return {
    id: nextId(`${hallId}_${kind}`),
    name,
    kind,
    position,
    rotationY: 0,
    size,
    material: { kind: materialKind, baseColor: color, roughness: materialKind === 'ceramic' ? 0.25 : 0.5, metallic: materialKind === 'bronze' ? 0.9 : 0, patternStrength: 0.7 },
    importance: 2,
  }
}

export { takeSnapshot }
