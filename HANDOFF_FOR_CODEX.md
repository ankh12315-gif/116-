# 交接文档 · 116 配电室火灾三维可视化系统

> 交接对象：codex
> 交接人：WorkBuddy（已完成 P0 / P1 / P2 全部开发，浏览器实测与截图已完成）
> 交接时间：2026-10-08
> 项目根：`D:\可视化\不开窗\WorkBuddy_116_Fire_Visualization`

---

## 0. 一页速览

| 项 | 状态 |
|---|---|
| 前端工程 | ✅ 可运行，Vite + React 18 + TS + Three.js(R3F) |
| 源码规模 | 32 文件 / 8931 行 TS+TSX |
| 真实 FDS 房间几何 | ✅ 484 OBST → 126 实体 + 358 面片 |
| 数据接入 | ✅ **16/16 工况全部 READY**（15 SPAN + 1 PER_LSB） |
| 类型检查 `tsc -b` | ✅ 退出码 0 |
| 构建 `vite build` | ✅ 643 modules，11.00s |
| 单元测试 `vitest run` | ✅ **143/143 passed**（121 coords + 22 provider） |
| 文档+资产校验 | ✅ `--check-ux` 退出码 0 |
| 浏览器实测截图 | ✅ **21 张**，`docs/screenshots/` |
| **遗留 P0/P1 违规** | ❌ **4 处（V1–V4），见 §4。这是 codex 的第一任务** |
| 交付文档 | ❌ 本文档 + `TODO_NEXT.md` 外，README/验收报告仍需补（见 §7） |

**接手第一件事：修 §4 的 V1。** 它是 15/16 工况温度场显示正确性的唯一守门判据，当前仍保留两级已被实测证伪的兜底猜测。

---

## 1. 启动方法

```bash
cd "D:/可视化/不开窗/WorkBuddy_116_Fire_Visualization"
npm install

# 开发（实测可用端口 5180）
npx vite --port 5180 --host 127.0.0.1
# → http://127.0.0.1:5180/

# 类型检查
npx tsc -b

# 构建 ⚠️ 必须带 --emptyOutDir=false
npx vite build --emptyOutDir=false

# 单元测试
npx vitest run
```

### ⚠️ 环境坑位（务必遵守）

| 坑 | 现象 | 正解 |
|---|---|---|
| **构建批量删除保护** | `npm run build` 报 `[SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":736}` 而中断 | 用 `npx vite build --emptyOutDir=false`，不要改 `package.json` 的 build 脚本绕过 |
| 资产重建 | `npm run assets` 会重跑转换器覆盖现有资产 | **慎用**。当前资产已经过 `fix_hrr_sampling.py` / `fix_slice_dims.py` / 140MW 修复等**多轮后处理**，重跑 `convert_fds_outputs.py` 会打回原形 |
| 无 git | 仓库未初始化 | 改代码前先 `git init` 或自行备份 |

---

## 2. 已完成的核心技术成果

### 2.1 真实 FDS 几何重建（`scripts/build_scene.py`）

- 解析 `&MESH/&OBST/&HOLE/&VENT/&SURF/&RAMP/&DEVC/&SLCF`
- 484 OBST → 126 实体 + 358 面片 + 24 开孔，11 种几何签名
- master mesh = `116-diya-1`
- 坐标变换：`three = [x, z, -y]`，反变换 `fds = [X, -Z, Y]`
- 渲染：`InstancedMesh` 按材质族合批（126 + 358）

### 2.2 二进制格式完整解码

| 格式 | 结构 | 用途 |
|---|---|---|
| `.sf` | Fortran unformatted：rec0/1/2 = 3×30B 标签 → rec3 = 24B 网格边界 → rec4 = frame time → rec5 = data | 三向温度切片 |
| `.s3d` | 同上但**含 RLE 压缩**：rec0 = 32B `[1,0,i1,i2,j1,j2,k1,k2]` → rec1 = int32 `0` → rec2 = `[rawLen,compLen]` → rec3 = 压缩掩码；每帧 3 条记录 | 三维体数据 |
| `.sz` | **不是 gzip**（实测头部 `20 20`），是 ASCII 帧索引：第 0 行掩码描述 + 后 1000 行帧索引 | 帧索引交叉校验 |
| `.smv` | `SLCF <meshIdx> # <comment> & i1 i2 j1 j2 k1 k2 ! <fileIdx> 0` | 切片索引 |

**踩坑记录（codex 若要改解析器必读）：**
1. `.smv` 的 `#` 注释段夹在 `meshIdx` 和 `&` 之间 —— 正则需容错
2. 内层 bounds 正则**不应重复匹配 `&`**（外层 `group(2)` 已消费）
3. FDS 6.8 的 `.smv` **没有 MESH 段**，网格边界必须从 `.fds` 的 `&MESH` 按出现顺序读（SMV mesh 序号 == FDS `&MESH` 顺序，1-based）
4. `.s3d` 每 mesh 4 个文件中**只有 index 3 是 TEMPERATURE**（1=SOOT DENSITY, 2=HRRPUV, 3=TEMPERATURE, 4=CO2 DENSITY）
5. `.s3d` RLE 文法实测：`FF <val> <cnt>` → 输出 cnt 个 val；其余单字节按字面量输出。体素 C 序（i 最快，k 最慢），`lin = (k*nj + j)*ni + i`

### 2.3 色彩管理与色标

- 渲染器色彩管理：`NeutralToneMapping`（Khronos PBR Neutral），`toneMappingExposure = 1.0`，`outputColorSpace = SRGBColorSpace`
- ⛔ **不可用 ACESFilmic** —— 会把暖白 `#F5F3EE` 压成灰黄
- 相机 `FOV = 32`（`src/scene/SceneRoot.tsx`）
- 12 锚点感知均匀色标 `TEMP_STOPS`：`#F8F3E9` / `#F5E9CF` / `#EFD9A0` / `#E8C070` / `#E0A24C` / `#D67F3C` / `#CC5E36` / `#B73D3F` / `#8C2C4C` / `#652557` / `#3B1C4C` / `#2D1543`
  - 拟合 `L* = -83.76×u + 96.05`，最大残差 **1.03 L***
  - 三类色觉模拟（deuteranopia / protanopia / tritanopia）下 L\* 全单调
- 灯光：火源点光 `fireAlarmLit`，仅 FIRE_ALARM 状态下强度 1.1

---

## 3. 数据层约定（**codex 必读，违反会渲染错误温度**）

### 3.1 切片量化的两套语义

这是本项目**最关键的数据正确性问题**。

| `scaleMode` | 公式 | 步长 | 定义域 | 工况数 | 切片帧数 |
|---|---|---|---|---|---|
| `SPAN` | `T = baseC + (byte/255) × scaleC`，`scaleC = 780` | 3.0588 ℃ | 20–800 ℃ | 15 | 101 |
| `PER_LSB` | `T = baseC + byte × scaleC`，`scaleC = 2000/255 ≈ 7.8431` | 7.8431 ℃ | 20–2020 ℃ | 1（HV-01-140MW） | 1001 |

**权威判据：`manifest.scaleMode` 字段**（两个转换器显式写入）。零启发式。

### 3.2 ⛔ 已作废的判别式（**严禁复活**）

| 作废判据 | 作废原因 |
|---|---|
| `scaleC > 100 → SPAN` | 量级启发式，非因果判据 |
| `frameCount` 判别 | 帧数是编码方式的**产物**，与语义可独立变化 |
| 残差自检判别 | `20+(255/255)×(dataMaxC−20) ≡ dataMaxC` 是**代数恒等式，零信息量** |
| 矛盾组合判别（`byteMax===255 && dataMaxC<800`） | 数据修复后失效（140MW 饱和字节已归零） |
| 逐片 `dataMaxC` 归一化（`PER_SLICE`） | 会掩盖真实饱和 |
| `isV2SliceAsset(meta) = meta.gridDims !== undefined` | `fix_slice_dims.py` 给**全部 16 工况**补写了该字段，判据对 16/16 返回 true，导致 15 个 SPAN 工况全被误判 PER_LSB（最高温算成 10.8~19.7 万 ℃） |
| `quantizationClipped` 字段 | 全库失效：618 片键缺失 + 49 片写 False + 0 片写 True |

**前端检测真饱和的现行正确逻辑**：`scaleMode === 'SPAN' && byteMax === 255 && dataMaxC > 800`

### 3.3 实测资产状态（`public/assets/results/<SCENARIO>/`）

```
16 个工况目录：HV-01-{40,70,100,140}MW / HV-02-{40,70,100,140}MW / LV-01..08-FIRE
scaleMode 分布：{ SPAN: 15, PER_LSB: 1 }
切片帧数分布：15 工况 = 101 帧；HV-01-140MW = 1001 帧
切片数：高压 49 片（HV-01）/ 43 片（HV-02）；低压 37~39 片
体数据：仅 HV-01-140MW 有 volume/
```

### 3.4 HV-01-140MW 的 V2 复算接入（**已解禁**）

`source_fds/116-gaoya-1-140mw.fds` 原始输入有误（`HRRPUA=5.6E6` = 1400 MW），V2 包已修正为 `5.6E5 kW/m²`，火源面 0.25 m²，标称 140 MW。

```json
"dataProvenance": {
  "origin": "V2_HANDBOX_RECALC",
  "sourceFdsSha256": "7019c0bb4a1f68513785de2d9d84025d11fb5429a49ee73920568a38e90be859",
  "sourceFdsHrrpua": 560000.0,
  "verifiedBy": "scripts/convert_v2_140mw.py",
  "verifiedAt": "2026-10-08T14:25:12.199454+08:00",
  "fdsCompletedSuccessfully": true,
  "inputCorrection": "HRRPUA 5.6E6 -> 5.6E5 已修正并复算"
}
```

⛔ **旧错误文件** `archive_superseded_DO_NOT_USE/116-gaoya-1-140mw__old_WRONG_1400MW.fds` 仅供历史审计，**不得用于前端**。
⛔ **UI 禁展示 `source_fds/*.fds` 下载链接** —— 项目内副本仍是 `HRRPUA=5.6E6`，会误导用户。

### 3.5 HRR 三量模型（**必须严格区分**）

| 量 | 字段 | 来源 | HV-01-140MW 实测 |
|---|---|---|---|
| 标称设定 | `nominalPeakHRRKW` | `HRRPUA × 火源面面积`，**输入参数** | 140,000 kW |
| 输出峰值 | `measuredPeakHRRKW` / `manifest.hrr.peakKW` | `*_hrr.csv`，**FDS 计算结果** | **13,382.431 kW @ t=3.6011 s** |
| UI 展示值 | 当前 ③ === ② | — | 13,382.431 kW |

**短时火源实测释热历程**（`hrr.json` 全分辨率 1001 帧，`sampling: FULL_RESOLUTION`）：

```
t =    0.00 s       0.0 kW
t =    1.80 s    7334.5 kW
t =    3.60 s   13382.4 kW   ← 峰值
t =    5.41 s    2941.2 kW
t =    7.21 s     270.7 kW   （峰值的 2.02%）
t =   10.82 s      96.2 kW
t =   59.42 s      88.1 kW
t = 1800.00 s       0.0 kW
```

⛔ **不得假设 140 MW 持续燃烧 1800 秒。** 高压火源计划释放约 1 秒，之后观察 1800 秒内的热量传播。

**峰后衰减时间两个口径**：
- 口径 A = 跌破峰值 2% 的**绝对时刻** = 9.01 s
- 口径 B = 峰后耗时 = A − 峰值时刻 = **5.40 s** ← **主口径采用 B**

恒等式 `A − B ≡ 峰值时刻` 在 8 个高压工况全部精确成立。

### 3.6 数据来源分层与溯源

`dataProvenance.origin` 五层：`FDS SIMULATED` / `SENSOR` / `DEMO` / `UNAVAILABLE` / `FDS INPUT ONLY`

字段：`{origin, sourceFdsSha256, sourceFdsHrrpua, verifiedBy, verifiedAt, fdsCompletedSuccessfully, inputCorrection}`

**热电偶字段命名更正**：原 `cabinetMaxC` 已重命名为 **`fireSourceMaxC`**，并新增 `sensorEnvelopeFdsM` + `sensorScopeNote`。原因：实测 LV-01 的 105 支热电偶**全部集中在** x∈[10.15,10.85]、y=−13.65、z∈[0.26,2.26] 的 0.7 m 竖直柱体内，**不存在逐柜温度映射**。`queryCabinetTemperature()` 用 `series.fireSourceMaxC`。

---

## 4. ❌ 遗留违规 V1–V4（codex 的第一任务）

以下 4 处由 `UX_SPEC.md` 附录 D **逐行实测定���**得出，`--check-ux` 校验器**故意不检查代码实现**，所以纯字符串检查全绿 ≠ 事实正确。

### V1 · P0 · `src/utils/coords.ts:218-230` `resolveScaleMode()`

**问题**：函数体仍保留两级已被实测证伪的**猜值兜底**：

```typescript
export function resolveScaleMode(
  q: { scaleC: number; scaleMode?: QuantScaleMode } | undefined | null,
  evidence?: SliceScaleEvidence | null,
): QuantScaleMode {
  // ① manifest 显式字段 —— 直接采信
  if (q?.scaleMode) return q.scaleMode;                    // ← 唯一正确的判据
  // ② 资产自身矛盾组合探测（仅在提供了字节极值证据时可用）
  if (hasScaleContradiction(evidence)) return 'PER_LSB';    // ← 违规：已作废判据
  // ③ scaleC 量级兜底
  const scaleC = q?.scaleC;
  if (typeof scaleC !== 'number' || !Number.isFinite(scaleC)) return 'SPAN';
  return Math.abs(scaleC) >= SCALE_MODE_THRESHOLD ? 'SPAN' : 'PER_LSB';  // ← 违规：量级启发式
}
```

关联死代码（应一并清理）：`SCALE_MODE_THRESHOLD`（L138）、`SCALE_CONTRADICTION_MAX_C`（L147）、`hasScaleContradiction`（L182-188）、`isV2SliceAsset`。

**修法**：
```typescript
export function resolveScaleMode(
  q: { scaleC: number; scaleMode?: QuantScaleMode } | undefined | null,
): QuantScaleMode {
  if (q?.scaleMode) return q.scaleMode;
  throw new Error('切片资产缺少 manifest.scaleMode 字段，拒绝猜测量化语义');
}
```
调用侧 `quantSpecFromSlice()`（L238-247）去掉 `evidence` 参数；UI 层捕获该异常并显示「资产缺少 scaleMode 字段」。

⚠️ 注意 `resolveScaleMode` 的第二个参数 `evidence` 目前还被 `quantSpecFromSlice` 传递，删除参数时需同步改签名。

### V2 · P0 · `src/ui/StatusBar.tsx:107`

**问题**：无条件渲染写死常量：
```tsx
import { SLICE_CMAP_NOTE } from '../utils/coords';   // L12
...
{SLICE_CMAP_NOTE} · 两栅格取样方式不同（标量线性插值 / 切片最近邻帧）   // L107
```
`SLICE_CMAP_NOTE` 在 `coords.ts:409` 写死 `'8bit 量化 · 步长 3.06 ℃'` → 切到 140MW 时显示 3.06，**实际 7.84**。

**修法**：与 `Legend.tsx:83` 一致走动态取值（`Legend.tsx:83` 已正确实现 `const note = cmapNote ?? SLICE_CMAP_NOTE;`，`App.tsx:287-289` 已正确传入 `cmapNote={sliceDomain?.note}`）。StatusBar 需从 store 取当前工况的 `sliceDomain.note`。

### V3 · P1 · `src/ui/StatusBar.tsx:100`

**问题**：tooltip 写死「切片为 **101 帧**最近邻取样」→ 140MW 实测 `frameCount = 1001`（已实测确认：15 工况 101 帧、140MW 1001 帧）。

**修法**：改为读取当前切片 meta 的 `frameCount` 动态渲染。

### V4 · P1 · `src/ui/DisclaimerDrawer.tsx:230-231`

**问题**：
```
切片二进制为 8bit 量化（T = 20 + b × 3.0588 ℃），
定义域 20–800℃，上下两端都存在截断。
```
→ 140MW 应为 `T = 20 + b × 7.8431 ℃`、定义域 **20–2020 ℃**。

**修法**：从当前 `scaleMode` 动态生成公式串与定义域；同时注意"上下两端都存在截断"这句对 PER_LSB 是否成立需复核（140MW 修复后 byteMax=136，**上端未饱和**）。

---

## 5. 已达标项（**codex 不要返工**）

| 项 | 位置 | 说明 |
|---|---|---|
| 图例域动态 | `src/app/App.tsx:286-289` | `domainMaxC` / `cmapNote` 已动态传入 |
| 图例文案降级 | `src/ui/Legend.tsx:83` | `cmapNote ?? SLICE_CMAP_NOTE` |
| TopBar tooltip 动态 | `src/ui/TopBar.tsx:76-85` | 已按 scaleMode 动态 |
| 切片解码走结构化入口 | `src/scene/ThermalSlices.tsx:79` | `quantSpecFromSlice` + L201 交叉校验 |
| `frameIndex` 上界 | `src/scene/ThermalSlices.tsx:145` | 取 `meta.frameCount` 而非硬编码 |
| StatusBar 帧栅格文案 | `src/ui/StatusBar.tsx:65-67` | 已动态（仅 L100 tooltip 仍写死，见 V3） |
| 柜体配色 | `src/scene/RoomGeometry.tsx` `colorForFamily()` | `COLOR_CYAN` 重映射 `#e3e1da`，6 个族全覆盖，避免赛博蓝 |
| 体渲染 NaN 防护 | `src/scene/ThermalVolume.tsx` | `safeRd` 避免 `0*inf=NaN` 导致整像素黑 |
| `frameCount` 上界动态 | — | 已实测 15 工况 101 / 140MW 1001 均正确渲染 |
| 单元测试 | `src/__tests__/` | 143/143 passed |

---

## 6. 文件清单

### 6.1 前端源码（32 文件 / 8931 行）

```
src/
  main.tsx  app/App.tsx (411)  vite-env.d.ts
  types/domain.ts (475)
  utils/coords.ts (606)  utils/format.ts
  data/scenarioProvider.ts (499)
  store/useFireStore.ts (610)
  scene/  SceneRoot.tsx  RoomGeometry.tsx (350)  CabinetAnchors.tsx
          SliceFrameOutline.tsx  ThermalSlices.tsx  ThermalVolume.tsx (412)
  ui/     TopBar  BottomDock  Timeline (415)  DeviceCard (486)
          ScenarioSelector (477)  AlarmBanner  Legend  EventList
          DisclaimerDrawer  StatusBar  ReleaseProfilePanel  VolumePanel
  audio/alarmAudio.ts
  __tests__/  coords.test.ts (902, 121 tests)  provider.test.ts (22 tests)
          node-test-globals.d.ts (24)
```

### 6.2 数据转换脚本（`scripts/`，13 个）

| 脚本 | 作用 | 状态 |
|---|---|---|
| `build_scene.py` | 几何转换 484 OBST → 126 实体 + 358 面片 | ✅ 已跑 |
| `convert_fds_outputs.py` | 主转换器（SPAN，`scaleC=780`） | ✅ 已跑，SHA `198d90a8e90d8354` |
| `convert_v2_140mw.py` | 140MW 专用（PER_LSB，`scaleC=2000/255`） | ✅ **已修复并重跑** |
| `convert_s3d.py` | `.s3d` 体数据解析（RLE + `.sz` 校验） | ⚠️ **未同步 `scaleMode`，重跑会丢该字段** |
| `fix_hrr_sampling.py` | HRR 抽稀丢峰修复（201 → 1001 帧全分辨率） | ✅ 已执行 |
| `fix_slice_dims.py` | 垂直切片 ni/nj 修正（PBX/PBY `1×16` → `16×66`） | ✅ 已执行（但它给全部 16 工况补写 `gridDims`，是 V1 判据失效根因） |
| `scenarios_manifest.py` | 16 工况 `dataProvenance`（实算 SHA256/HRRPUA/`.out`） | ✅ 已跑 |
| `analyze_release_profile.py` | 8 个高压工况释热历程统计 | ✅ 已跑 |
| `verify_doc_consistency.py`（~1154 行, v2.6） | 文档级 + 资产级校验器 | ✅ `--check-ux` 退出码 0 |
| `test_converters.py` | 58 tests（42 旧 + 16 新） | ✅ 58/58 |
| `test_decode_rules_v25.py` | 22 例校验器回归（14 违规全抓 / 8 合法全放行 / 0 假阳） | ✅ |
| `verify_hrr_independent.py` | HRR 独立复核 | ✅ |

### 6.3 规范文档（团队产出）

| 文档 | 行数 | 权威性 |
|---|---|---|
| `DESIGN_SYSTEM.md` | 1250, v2.6 | 视觉规范权威。16 条红线 D1–D10 + D7b/c + D11 判据 7 项。§3.2 色标、§3.2b 切片量化、§2.1 渲染器、§2.5 相机、§4.15 HRR 曲线、§4.16 短时火源 |
| `UX_SPEC.md` | 2374, v2.5 | 交互规范。状态树、7 步流程、15 项边界异常 E-1–E-17、验收断言 U1–U33、**附录 C 资产身份绑定**、**附录 D P0-4 验收标准（V1–V4 来源）** |
| `docs/TODO_FDS_HRR.md` | ~328 | 4 条相互独立的未解释维度（见 §8） |

⚠️ **DESIGN_SYSTEM.md 版本历史混乱**：v2.3/v2.4 结论已由 v2.5 撤回，文档内保留供追溯，**读时以 v2.5 为准**。

### 6.4 截图（`docs/screenshots/`，21 张）

```
01_main_view.png                 02_hv01_40mw.png
03_lv01.png04_alarm_state.png       04b_alarm_banner.png
05_future_t30s.png06_thermal_slices_pbz.png
07_legend_closeup.png            07b_legend_closeup_lv01.png
08_hv01_140mw_perlsb.png         08b_legend_140mw_OCCLUDED_evidence.png
09_volume_data.png               12_thermal_field_hv40_t18.png
13_thermal_field_hv40_closeup.png  14_thermal_field_hv140_t1p8.png
15_thermal_field_hv140_closeup.png  16_thermal_field_lv01_t90.png
17_topdown_hv40_t18.png          18_topdown_hv140_t1p8.png
19_topdown_lv01_t90.png21_legend_occluded_evidence.png
22_legend_occlusion_detail.png
```

已覆盖：主视图 / 高压 / 低压 / 报警 / 未来预测 / 切片 / 色标图例 / 140MW PER_LSB / 体数据 / 热场特写 / 顶视图 / 图例遮挡取证。

---

## 7. 待补交付文档

| 文档 | 状态 | 内容要点 |
|---|---|---|
| `README.md` | ⚠️ 现有 38 行是**交接包原始说明**，需重写 | 项目简介、安装运行、使用方式、FDS 数据补充指引 |
| `VALIDATION_REPORT.md` | ❌ 未写 | 数据审计、构建结果、人工 QA、限制说明、截图路径索引 |
| `TODO_NEXT.md` | ❌ 未写 | 未接入清单、HRR 成因核查、4 条未解释维度 |
| `HANDOFF_VALIDATION.md` | 现有 18 行（交接包原始） | — |

---

## 8. 其他遗留技术债

### 8.1 P1 · `convert_s3d.py` 未同步 `scaleMode`

体数据转换器未写 `scaleMode` 字段。**重跑会丢该字段** → V1 修完后会直接抛错。需补写。

### 8.2 P2 · 5 个真饱和片未标 `quantizationClipped`

校验器实测输出：
```
quantizationClipped：键不存在 618 / 写 False 49 / 写 True 0
⛔ 真饱和片未标 True：LV-01-FIRE / 116-diya-1_3_1.bin
⛔ 真饱和片未标 True：LV-03-FIRE / 116-diya-3_2_1.bin
⛔ 真饱和片未标 True：LV-05-FIRE / 116-diya-5_2_1.bin
⛔ 真饱和片未标 True：LV-06-FIRE / 116-diya-6_2_1.bin
⛔ 真饱和片未标 True：LV-07-FIRE / 116-diya-7_2_1.bin
根因：convert_fds_outputs.py 从未写入该字段 → 618 片 None 是「SPAN 侧未实现」
```
前端已用正确逻辑自行检测（`scaleMode==='SPAN' && byteMax===255 && dataMaxC>800`），故不阻塞功能。

### 8.3 决策项 · `source_fds/116-gaoya-1-140mw.fds` 是否替换为 V2 版本

当前建议**不替换**（保持历史可追溯），但 ⛔ UI 禁展示 `source_fds/*.fds` 链接，因项目内副本仍是 `HRRPUA=5.6E6`。若要替换，需同步更新 `dataProvenance.sourceFdsSha256`。

### 8.4 P2 · 资产路径双份

`public/assets` 与 `dist/assets` 路径未统一，缺校验。建议加一致性检查脚本。

### 8.5 4 条未解释维度（`docs/TODO_FDS_HRR.md`）

四条**相互独立**、尚未定论的观测差异：
1. **幅度差 10×**：双簇分布（低压簇 94.91–96.72% / 高压簇 6.62–11.00%，30–80% 区间 0 样本）
2. **形状差异**
3. **TIMER 有无**：高压 7 工况有 `SETPOINT=1.0`，低压 8 工况完全没有
4. **峰后衰减时间**

⛔ 这四条**只描述现象，不做因果解释**。codex 若要继续核查，**不得双向解释**（不能说"因为 A 所以 B"，也不能说"因为 B 所以 A"）。

---

## 9. ⛔ 措辞纪律（codex 写作时必须遵守）

| 禁令 | 说明 |
|---|---|
| **禁止因果解释双向** | 只能说"观测到 A 与 B 同时出现"，不能说"A 导致 B"也不能说"B 导致 A" |
| **禁止用 `series.json` 做统计** | `series.json` 是 201 帧抽稀产物。末非零 t 必须取「末个 `hrrKW > 0` 的帧」。**阀值：直接读 `hrr.json`** |
| **禁展示 `source_fds/*.fds` 链接** | 项目内副本仍是错误的 `HRRPUA=5.6E6` |
| **禁止假设 140 MW 持续燃烧** | 实测峰后 5.4 s 即跌破峰值 2% |
| **禁止伪造温度预测** | 无 FDS 输出时必须显示"未接入" |
| **资产更新后必须重跑校验器** | 不得沿用旧统计量（v1.7a 的 6 处错误即由此产生） |

---

## 10. 方法论教训（**这是本项目最贵的产出**）

设计专家团队连续 3 轮判别式翻车，根因都是同一个：**没先问"这个判据在什么情况下会失效"**。

| 轮次 | 错误判据 | 失效原因 |
|---|---|---|
| ux v2.2 | 假设 `scaleC` 参与了编码 | 与实际编码无关 |
| ux v2.3 | 用代数恒等式 `20+(255/255)×(dataMaxC−20) ≡ dataMaxC` 当证据 | **零信息量的恒等式**，任何数据都"成立" |
| visual v2.3 | 用 `frameCount > 500` 判别 | 用**产物**（编码方式的结果）判断**原因**（语义） |

**沉淀为三条硬规则：**

1. **每个判据必须写下使其失效的构造反例。** 不能回答"什么时候会错"的判据不许上线。
2. **纯字符串检查全绿 ≠ 事实正确。** `--check-ux` 退出码 0 是必要条件，不是充分条件 —— V1–V4 正是校验器故意不覆盖、靠逐行实测才发现的。
3. **资产级实测结论必须绑定 mtime + SHA-256 + 转换器版本**（`UX_SPEC.md` 附录 C）。否则资产一重跑，结论就变成无法追溯的传言。

---

## 11. 建议的接手顺序

1. **修 V1**（`coords.ts`）→ 跑 `npx vitest run` 确认 143 仍全绿（现有测试**不覆盖** V1，测试全绿不代表 V1 修对了，需人工核对 16 工况解码结果）
2. **修 V2 / V3**（`StatusBar.tsx` 三处）→ 切 140MW 截图核对显示 7.84 / 1001 帧
3. **修 V4**（`DisclaimerDrawer.tsx`）→ 切 140MW 核对 7.8431 / 20–2020 ℃
4. 跑三路验证：`npx tsc -b` + `npx vite build --emptyOutDir=false` + `npx vitest run` + `python scripts/verify_doc_consistency.py --check-ux`
5. 补 `scripts/convert_s3d.py` 的 `scaleMode` 字段
6. 补写 `README.md` / `VALIDATION_REPORT.md` / `TODO_NEXT.md`
7. 可选：5 个真饱和片补 `quantizationClipped: true`、资产路径校验脚本、`git init`

---

## 12. 一句话总结

**三维房间、几何重建、16 工况数据接入、交互、报警、构建、143 测试、21 张浏览器实测截图全部完成并验证通过；剩 4 处已精确定位的 UI 显示违规（V1 为 P0）+ 3 份交付文档待补，V1 是唯一影响数据正确性的守门判据，codex 从 `src/utils/coords.ts:218-230` 开始接手即可。**
