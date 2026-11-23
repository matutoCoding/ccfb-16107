# 虚拟展厅布展与光照烘焙系统

浏览器内运行的参数化布展 + GPU 路径追踪光照烘焙管线，替代 Unity 离线烘焙。
技术栈：Vue 3 + TypeScript + WebGPU（compute）+ WGSL，数据全部存 IndexedDB，发布端只读贴图、不跑实时光照。

## 启动

```bash
npm install
npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 类型检查 + 生产构建
npm run test:smoke # 核心管线冒烟测试（2798 项断言）
```

WebGPU 不可用时自动回落 CPU 路径追踪与 Canvas2D 预览，功能不缺失，仅速度下降。

## 六个页面与职责

| 页面 | 职责 |
| --- | --- |
| 展厅列表 | 模板建厅、删除、烘焙状态总览 |
| 布展编辑 | 墙/吊顶/展柜/展台参数化搭建，瓷瓶/青铜鼎/书画程序生成，自动光照 UV 与图集利用率 |
| 灯光设置 | 轨道射灯/洗墙灯/线形灯/天窗光，光束角调节，IES LM-63 导入与配光曲线 |
| 烘焙队列 | 采样/弹射参数，全量与增量烘焙，分块进度，失效审计，后端自动选择 |
| 烘焙检查 | 分通道查看、密度热力图、逐像素误差图、漏光/阴影/接缝标注、降噪前后对比 |
| 发布预览 | 手机/桌面两档贴图压缩、16MB 硬预算、反射探针、手机分辨率展线巡览 |

## 管线架构

```
参数化几何 (box/lathe/scroll)
   └─> 表面参数化采样器（纹素 <-> 世界点严格互逆）
         ├─> 光照 UV：面积 × 重要度权重 -> MaxRects 图集打包（利用率可见）
         ├─> BVH（扁平节点，CPU/GPU 同构）
         │     ├─> CPU 路径追踪器（NEE 直接光 + 多弹射间接光 + AO，分通道累积）
         │     └─> WebGPU compute kernel（WGSL，8×8 workgroup 按 chart dispatch）
         ├─> 边缘膨胀（防接缝）+ G-buffer 引导 a-trous 降噪（保阴影/纹饰）
         ├─> 增量失效分析（self-moved / shadow-frustum / neighbor-probe / light-changed）
         └─> 质检：参考路径追踪逐像素误差、漏光、阴影错位、接缝色差、密度热力图
```

### 增量烘焙的依据（可审计，不允许静默全量）

1. `self-moved`：物体自身位置/尺寸/材质指纹变化，其全部 chart 失效
2. `neighbor-probe`：表面落入移动物体 2.5m 邻域带，间接光与 AO 受影响
3. `light-changed`：灯光参数变化且表面在其光锥内
4. `shadow-frustum`：灯-移动物体-目标表面共线，判定新阴影遮挡关系

影响面超过 70% 时标记 `fullBakeRecommended`，UI 必须弹确认才能全量。

## 关键数据结构

- `src/core/types.ts`：全管线领域模型与数据契约
- IndexedDB stores：`halls / bakes / textures / ies / probes / publishes / snapshots`
- 烘焙纹理按 direct / indirect / ao 三通道分别入库，另存降噪前原始通道用于对比

## 验收指标对照

| 目标 | 实现位置 |
| --- | --- |
| 平均误差 < 2% | `quality_inspector.evaluateQuality`，检查页给 go/no-go 结论 |
| 30 展柜全量 ≤ 10 分钟 | WebGPU compute 优先，CPU 分块时间片调度，参数可调 |
| 挪展柜增量 ≤ 1 分钟 | 失效分析只重烘受影响 chart，旧图集就地覆盖 |
| 接缝无色差 | 膨胀填充 + 接缝扫描自动定位超阈值纹素 |
| 手机端不算实时光 | 发布包仅含 WebP 贴图与探针，运行时只采样 |

## 目录约定

```
src/core/geometry/   参数化几何与表面采样
src/core/renderer/   Canvas2D 预览、WebGPU 设备与 WGSL kernel
src/core/storage/    IndexedDB 仓储与纹理编解码
src/core/            烘焙、BVH、UV、增量、质检、发布等领域模块
src/pages/           六个业务页面
src/components/      设计 token 驱动的通用组件
```
