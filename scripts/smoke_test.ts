// 核心管线冒烟测试：几何 -> 图集 -> BVH -> 烘焙 -> 增量 -> 质检，不依赖 DOM
import { createHallFromTemplate } from '../src/core/storage/hall_repository'
import { buildSceneGeometry } from '../src/core/geometry/geometry_builder'
import { buildLightmapAtlas } from '../src/core/uv_atlas'
import { buildBvh, traceRay } from '../src/core/bvh'
import { CpuPathTracer } from '../src/core/path_tracer'
import { analyzeInvalidation, takeSnapshot } from '../src/core/incremental_bake'
import { detectLightLeak, detectSeamDiscontinuity, computeErrorMap } from '../src/core/quality_inspector'
import { dilateAtlas, denoiseAtlas } from '../src/core/dilate_denoise'
import { parseIes } from '../src/core/ies'
import { v3 } from '../src/core/math3d'

let passed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) throw new Error(`断言失败：${name} ${detail}`)
  passed += 1
  console.log(`  ok - ${name}`)
}

const hall = createHallFromTemplate('冒烟测试厅')
hall.bakeSettings.atlasSize = 1024
hall.bakeSettings.baseTexelDensity = 8
hall.bakeSettings.samplesPerPixel = 2
hall.bakeSettings.bounceCount = 1

console.log('1. 参数化几何')
const scene = buildSceneGeometry(hall)
check('几何物体数与场景一致', scene.geometries.length === hall.objects.length)
const vase = scene.geometries.find((g) => g.kind === 'vase')
check('瓷瓶车削面存在', !!vase && vase.patches[0].tag === 'lathe:side')
check('车削三角面已生成', (vase?.triangles.indices.length ?? 0) > 100)

console.log('2. 光照图集打包')
const atlas = buildLightmapAtlas(hall, scene)
check('图集尺寸 1024', atlas.size === 1024)
check('利用率在合理区间', atlas.utilization > 0.1 && atlas.utilization <= 1, `util=${atlas.utilization}`)
const vaseChart = atlas.charts.find((c) => c.objectId === vase?.objectId)
const floorChart = atlas.charts.find((c) => c.surfaceTag === 'ny')
check('展品纹素密度高于地面', !!vaseChart && !!floorChart && vaseChart.texelDensity > floorChart.texelDensity)
// chart 不重叠
for (let i = 0; i < atlas.charts.length; i++) {
  for (let j = i + 1; j < atlas.charts.length; j++) {
    const a = atlas.charts[i]
    const b = atlas.charts[j]
    const overlap = a.x < b.x + b.widthPx && a.x + a.widthPx > b.x && a.y < b.y + b.heightPx && a.y + a.heightPx > b.y
    check(`chart 无重叠 ${a.id}/${b.id}`, !overlap)
  }
}

console.log('3. BVH 射线查询')
const bvh = buildBvh(scene, hall.objects)
check('BVH 节点已构建', bvh.nodes.length > 0)
// 从厅中央向下打射线，应命中地面
const downHit = traceRay(bvh, [0, 2, 0], [0, -1, 0])
check('向下射线命中地面', !!downHit && hall.objects.find((o) => o.id === downHit.objectId)?.kind === 'floor')
// 向上打射线命中吊顶
const upHit = traceRay(bvh, [0, 1, 0], [0, 1, 0])
check('向上射线命中吊顶', !!upHit && hall.objects.find((o) => o.id === upHit.objectId)?.kind === 'ceiling')

console.log('4. CPU 路径追踪烘焙（最小 chart）')
const smallest = [...atlas.charts].sort((a, b) => a.widthPx * a.heightPx - b.widthPx * b.heightPx)[0]
const tracer = new CpuPathTracer({ hall, bvh, scene, iesById: new Map() })
const t0 = Date.now()
const output = tracer.bakeChart(smallest)
check('单 chart 烘焙有输出', output.pixels.direct.length === smallest.widthPx * smallest.heightPx * 3)
check('AO 在 0~1 之间', output.pixels.ao.every((v, i) => i % 3 !== 0 || (v >= 0 && v <= 1)))
console.log(`    耗时 ${Date.now() - t0}ms，chart ${smallest.id} ${smallest.widthPx}x${smallest.heightPx}`)

console.log('5. 膨胀与降噪')
const size = 64
const channels = {
  direct: new Float32Array(size * size * 3),
  indirect: new Float32Array(size * size * 3),
  ao: new Float32Array(size * size * 3),
}
for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) {
  const i = (y * size + x) * 3
  channels.direct[i] = channels.direct[i + 1] = channels.direct[i + 2] = 0.5
  channels.ao[i] = channels.ao[i + 1] = channels.ao[i + 2] = 1
}
dilateAtlas(channels, size, 3)
check('膨胀填充了间隙', channels.direct[((19) * size + 25) * 3] > 0)
const gbuffer = { normals: new Float32Array(size * size * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), objectIds: new Int32Array(size * size) }
const denoised = denoiseAtlas(channels, gbuffer, size, 2)
check('降噪输出通道完整', denoised.direct.length === channels.direct.length)

console.log('6. 增量烘焙失效判定')
const before = takeSnapshot(hall)
const cabinet = hall.objects.find((o) => o.kind === 'cabinet') as NonNullable<ReturnType<typeof hall.objects.find>>
cabinet.position[0] += 1.2
const after = takeSnapshot(hall)
const report = analyzeInvalidation(hall, atlas, before, after)
check('检出变更物体', report.changedObjectIds.includes(cabinet.id))
check('展柜自身 chart 被标记 self-moved', report.entries.some((e) => e.objectId === cabinet.id && e.reasons.includes('self-moved')))
check('影响面不是全量', report.affectedRatio < 1, `ratio=${report.affectedRatio}`)
check('每条失效都有原因说明', report.entries.every((e) => e.detail.length > 0))

console.log('7. 质检：漏光/接缝/误差图')
const fullChannels = {
  direct: new Float32Array(atlas.size * atlas.size * 3),
  indirect: new Float32Array(atlas.size * atlas.size * 3),
  ao: new Float32Array(atlas.size * atlas.size * 3).fill(0.8),
}
const leaks = detectLightLeak(fullChannels, atlas)
const seams = detectSeamDiscontinuity(fullChannels, atlas)
check('质检函数可运行', Array.isArray(leaks) && Array.isArray(seams))
const reference = new Float32Array(atlas.size * atlas.size * 3).fill(0.1)
const metrics = computeErrorMap(fullChannels, reference, atlas)
check('误差指标完整', metrics.meanError >= 0 && metrics.psnr > 0 && metrics.errorMap.length > 0)

console.log('8. IES 配光解析')
// 构造最小 LM-63 结构：TILT 后 10 个标头数，第 4 个为垂直角数、第 5 个为水平角数
const vertCount = 5
const iesText = [
  'TEST TILT=NONE',
  '1 1000 1 5 1 1 1 0 0 0',
  '0 22.5 45 67.5 90',
  '0',
  '1 0.9 0.6 0.3 0.05',
].join('\n')
const ies = parseIes('test.ies', iesText)
check('IES 角度解析', ies.angles.length === vertCount)
check('IES 光强归一化', Math.max(...ies.candela) <= 1.0001)

console.log('9. 向量库基础')
check('点积正确', v3.dot([1, 0, 0], [1, 0, 0]) === 1)
check('叉积正确', v3.cross([1, 0, 0], [0, 1, 0])[2] === 1)

console.log(`\n全部通过：${passed} 项断言`)
