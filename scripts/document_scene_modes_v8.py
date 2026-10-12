import json
from pathlib import Path
R=Path(__file__).resolve().parents[1];D=R/'docs/v8';A=R/'public/assets'
def read(p):return json.loads(p.read_text(encoding='utf-8'))
audit=read(D/'source-audit.json');verification=read(D/'asset-verification.json');candidates=read(D/'monitor-candidates.json');index=read(A/'scenes/windowless/scenarios.json')['scenarios']
total=sum(p.stat().st_size for p in (A/'scenes').rglob('*') if p.is_file())/1024**2
default=sum(p.stat().st_size for k in ['thermal','fields','results'] for p in (A/'scenes/windowless'/k/'WL-HV-01-40MW-B0').rglob('*') if p.is_file())/1024**2
table='\n'.join(f"| {s['id']} | {s['boundaryVariant']} | {s['openingAtS']:.6f} | READY |" for s in index)
stats='\n'.join(f"| {name} | {coord} | {min(x['riseC'] for x in candidates if x['candidate']==key):.2f}–{max(x['riseC'] for x in candidates if x['candidate']==key):.2f}℃ | 17 × 1001 |" for key,name,coord in [('wall','墙附近气相点','(12.5, −10.5, 3)'),('beam','梁下气相点','(11.5, −12, 4.5)'),('cabinet','柜附近气相点','(10.5, −13.5, 1.5)')])
files=['src/config/sceneModes.ts','src/config/fireSimulation.ts','src/data/sceneRegistry.ts','src/data/scenarioProvider.ts','src/data/thermalView.ts','src/data/fieldsV7.ts','src/types/domain.ts','src/store/useFireStore.ts','src/simulation/AutomaticFire.tsx','src/simulation/scenarioMatcher.ts','src/simulation/monitorCorrection.ts','src/app/App.tsx','src/scene/SceneRoot.tsx','src/scene/RoomGeometry.tsx','src/scene/DisasterVolumes.tsx','src/ui/SceneSwitcher.tsx','src/ui/SensorControl.tsx','src/ui/SimpleControls.tsx','src/styles/global.css','src/__tests__/scene-v8.test.tsx','scripts/build_scene_modes_v8.py','scripts/verify_scene_modes_v8.py','scripts/analyze_scene_modes_v8.py','scripts/document_scene_modes_v8.py']
report=f'''# V8 双场景实际交付与验收

2026-10-09。在既有 React/TypeScript/Three.js 工程内完成，未运行 FDS，未创建后台，未使用深度学习。顶部仅增加“有窗 / 无窗”。默认保留既有 HV-01/70MW 自动演示；无窗默认使用新增 HV-01/40MW、0s 构件移除版本。低压演示可在代码配置中改为 LV-01，不增加人工选择面板。

## 真实数据审计与名称限制

既有 16 工况：源目录 `D:/可视化/不开窗/116-gaoya-window`、`116-diya-window`，140MW 使用原项目已验证的 V2 重算文件。目录名称不是判断依据。对应输入均含六个常驻构件，无 HOLE；OPEN VENT 位于计算网格外边界。

新增来源：`D:/可视化/无窗/116-glassgao/glassgao` 与 `116-glassdi/glassdi`。高压 8 个版本仅 HV-01/40MW；低压 9 个版本仅 LV-01。同一柜位不同构件移除时间，不能称为 17 个不同柜位/功率工况。全部 FDS-6.8.0 输出成功，HRR/DEVC 各 1001 帧，温度切片、SOOT DENSITY 和 HRRPUV 均覆盖 0–1800s。

输入高压 482 OBST、12 HOLE；低压 484 OBST、24 HOLE。HOLE 位于柜体，不等同于建筑窗口。两组均用 TIMER->OUT 控制六个 OBST 移除。材质定义主要是颜色，未提供经过验证的玻璃破裂材料模型。“有窗/无窗”沿用用户提供的场景名称；新增资产**不是永久封闭无开口房间**，也不是隐藏旧窗得到的假场景。计算域为 X[−1,14]、Y[−17.5,2]、Z[0,6.5]m；计算域不冒称室内净尺寸。

真实移除时刻读取 SMV 的 **HIDE_OBST**，保留 DEVICE_ACT 作溯源，不用文件名/SETPOINT 或舍入设备时间代替几何时刻。例如高压 B0：DEVICE_ACT=0.06s，六个 HIDE_OBST=0.125252s。高压火源另有约1秒的关闭控制；仍读取独立 HRR 和 HRRPUV 输出，不能推断持续燃烧1800秒。

| 新增工况 | 文件夹时间(s) | 实际移除(s) | 输出 |
|---|---:|---:|---|
{table}

详细源文件路径、SHA、完成状态和控制记录见 [source-audit.json](source-audit.json)。索引以父目录时间识别；低压文件名 `116-diya-1s150` 的实际版本是150s。开发早期未索引派生 B1 已移入 `unindexed-build-artifacts` 保存，不进入场景索引或参与匹配。

## 架构及界面

统一页面与渲染组件，场景类型 `windowed | windowless`。`sceneModes.ts` 定义独立默认工况、MOCK源、监测点和自动规则；`sceneRegistry.ts` 校验几何身份并按真实时间过滤受控构件。既有16工况和新增17版本均解析各自原输入几何，保留原FDS坐标转换，HOLE真实裁剪，统一暖白/金属材质及光照。计算域一致时相机向量保持稳定，不因几何移除重置用户视角。

切换先暂停、清空当前工况/未来偏移/报警、递增场景请求序号，隐藏旧三维组，取消几何及大场数据请求，加载新索引与真实默认几何，重新开始独立MOCK时钟。起火匹配后等待本工况完整温度及烟气数据，再播放。HTTP失败显式不可用，不从另一场景回退。缓存按场景与工况索引；旧响应必须同时通过请求序号、工况ID和场景修订号检查。快速往返及延迟响应均有回归测试。MOCK手动读数及未来/跳转浮层在切换时重置。

新增资源全部位于 `public/assets/scenes/`，旧1129资产不变。新增 236 温度切片（3m、1.5m、PBX=11.5、PBY=−12），Float32原始摄氏度，共 {verification['float32ValuesBitVerified']:,} 值逐字节核对。Float32不经过8位解码；清单兼容字段不是其量化精度。原有SPAN/PER_LSB解码、公式、色标与溯源回归全部保留。

温度色带统一蓝→青→绿→黄→橙→红→紫红、固定绝对20–1200℃；超出显示域仅颜色饱和并注明，原始数值保留。多方向截面及40℃等温线不是完整体温度重建或火焰边界。

烟气使用各自真实SOOT DENSITY来源的152个SMOKE3D文件；复制字节一致。该版本8位编码是透明度/消光展示语义，不能称为无损浓度。局部热释放使用对应HRRPUV源帧，暖色强调由数据决定，并受当前HRR非零约束；它不是精确火焰边界，不由温度场伪造。缺失烟气时显示未接入。

没有恢复人工柜位/功率选择、顶部大报警框、专业分析或后台。保留顶部轻量状态、手动MOCK入口，模型工具、底部播放/时间轴/速度/未来。研究曲线和参数放在报告及代码中。点修正只作用于监测点，不修改空间颜色或源资产。

## 自动匹配及时间对齐

场景切换清除旧观测，新原点 `fireOriginAbsoluteS` 记录当前场景触发绝对时刻。FDS时间=传感器绝对时间−本场起火原点。固定1Hz因果采集、暂停/跳转/未来不生成匹配决策。每个场景独立曲线库及会话记录，最多保留5个会话；生产接入需替换SensorSource及柜位识别证据。

既有高压可在同柜功率库内匹配，V7 MOCK突变回放保留。无窗只搜索自己的17曲线，还限制同柜位、同实际开口时刻；单点相似性不能授权改变通风边界。因此现有无窗固定边界下只有一条HV功率曲线，突变后记录“没有可靠同柜候选”，不借用有窗70/100/140MW或另一开口时间。这是已适配的保守结果，不是完成了缺失功率的物理预测。

## 监测点覆盖与修正

从新增真实切片提取51条曲线，每条1001帧。指标来自实际源值，不外推未覆盖位置。详见 [monitor-candidates.json](monitor-candidates.json)，包括温升、峰值时刻、逐样本最大升温速度、源SHA及静态实体内部检查。四类候选结果：

| 部位候选 | FDS坐标(m) | 17版本最大温升范围 | 覆盖 |
|---|---|---:|---|
{stats}
| 屋顶正中间 | 待补充屋顶下气相DEVC | 不编造 | 尚无有效同点曲线证据 |

暂定继续使用梁下气相点 (11.5,−12,4.5)m：两个场景都有真实同坐标垂直切片，新增响应较墙附近明显，位于静态实体外，便于保持监测位置一致。柜附近候选对高/低压差异很大，输入切片测得的是气相而非安装在柜内的真实传感器；不能宣称响应快就最优。梁下点同样对LV弱响应，且位置/延迟/设备安装条件没有实测验证，**不是唯一最佳点或单点定位火源的物理结论**。建议后续补屋顶下、梁侧、墙面附近及柜内明确DEVC，统一输出和实验标定；本轮未运行FDS。此前16工况分析、推荐曲线和误差方法保留于 [V3报告](../v3/MONITOR_REPORT.md)。

修正 `deltaT=MOCK−同点FDS`，限幅±20℃，只更新独立点结果。未修正/模拟/修正分别存储，未来冻结当前偏差而不读取未来MOCK样本。浏览器30s示例：FDS46.93℃，手动MOCK95℃，点修正66.93℃；误差48.07→28.07℃（有界残差未消失）；房间最高温及空间颜色不变。不得称为真实实测或准确恢复整室场。已有80→90℃案例与同点/错时拒绝测试保留。

## 同工况对比

HV-01/40MW 与 LV-01 各选择两版本、共同查询时间3.6/30/300/900s；每场读取自身最近真实温度/HRR帧，明确帧时刻，梁下曲线仅同点线性查询。见 [comparison.csv](comparison.csv) 和 [comparison.json](comparison.json)。例如HV40查询3.6s：3m截面最高有窗804.22℃、新增1009.47℃；网页统计还包含1.5m及垂直切片，其最高值范围更广。两场额外HOLE与构件控制不同，不能宣称为仅窗开闭导致的因果温差。

实际网页同相机HV40/3.6s对照：

![有窗HV40](../screenshots/v8_compare_hv40_windowed_3p6.jpg)
![无窗HV40](../screenshots/v8_compare_hv40_windowless_3p6.jpg)

低压300s对照、1920×1080、1366×768和390×844手机、未来及MOCK手动读数截图均在 `docs/screenshots/v8_*.jpg`。截图是浏览器真实渲染，不是设计效果图。

## 测试与性能

`npx tsc -b`、`npx vite build --emptyOutDir=false`、`npx vitest run`、`python scripts/verify_doc_consistency.py --check-ux` 均通过；287项测试（原264项+新增23项），10个测试文件。日志在本目录。独立Python核对17案例、85个原始关键源文件SHA、236温度切片、152源一致体文件、608 RLE抽样帧；转换阶段逐帧检查152152体帧及尺寸/.sz记录。原1129资产SHA未变。没有覆盖旧量化资产。

浏览器实际验证：初次自动监测/定位/播放；双向及快速往返；HV40与LV01独立模型/温度/HRR/烟气；手动95℃、候选仅当前场景及不可靠拒绝；当前30→未来60→返回；屋顶/透明/俯视；1920/1366/390布局、无横向溢出。保存只读场景诊断和控制台检查于 [browser-verification.json](browser-verification.json)。初次浏览器发现清单量化兼容字段缺失已修正；精确HIDE_OBST时刻与延迟返回覆盖问题也已纳入测试。

新增场景资源约{total:.1f}MiB，当前默认无窗案例约{default:.1f}MiB，仅当前工况驻留。连续渲染的FPS受显卡、视口及后台标签节流影响，不保证60FPS。生产1920×1080页面单次渲染采样43.4FPS、55个绘制调用、36个几何与24个纹理；控制台warning/error为0。这是单次观察，不是持续播放性能保证。生产打包JS约1.06MB（gzip约301kB），首次本地加载资源较大；远程部署需压缩/范围请求或分段加载。未牺牲源数据精度来制造性能结果。

## 修改清单与未完成物理数据

'''+ '\n'.join(f'- `{p}`' for p in files)+'''

另新增 `public/assets/scenes/windowed/geometries/`、`public/assets/scenes/windowless/` 的独立索引、几何、曲线、结果、温度及烟气资产；更新README/UX_SPEC/DESIGN_SYSTEM/VALIDATION_REPORT/TODO_NEXT和本报告。旧FDS及其计算输出未修改。

尚缺无窗HV-02、70/100/140MW、LV-02～LV-08和永久封闭房间的对应结果；均不伪造、不跨场景回退。没有实测传感器、单点火源定位验证或空间修正验证。真实烟气浓度尚不作数值浓度重建；当前采用经版本核验的源烟气展示编码。两场对比不是单因素通风实验。未增加此前用户删除的UI入口。
'''
(D/'VALIDATION.md').write_text(report,encoding='utf-8')
prefix='''# V8：有窗 / 无窗双场景

当前顶部可直接切换场景，真实几何、独立温度/烟气/局部热释放、时间轴和MOCK自动逻辑同步切换。默认保留既有自动演示；新增场景只使用其已完成的高压和低压结果。切换暂停并重新计时，不跨场景回退，传感器可自行输入MOCK温度。

新增文件为定时移除六个构件的版本，包含柜体HOLE；“无窗”沿用上传名称，不代表永久封闭无开口房间。已有16工况和原SPAN/PER_LSB资产不变。两场统一绝对温度色标，点修正不修改空间场。

[完整V8数据审计、实际截图、对比、代码清单和验收](docs/v8/VALIDATION.md)。当前本地预览：http://127.0.0.1:5182/ 。运行V8资源构建时用 `python -X utf8 scripts/build_scene_modes_v8.py`；脚本仅写新派生目录，不执行FDS或旧转换器。

以下为历史版本记录；当前界面、数据范围和限制以V8报告为准。

---

'''
for name in ['README.md','UX_SPEC.md','DESIGN_SYSTEM.md','VALIDATION_REPORT.md','TODO_NEXT.md']:
 p=R/name;s=p.read_text(encoding='utf-8');
 if not s.startswith('# V8：'):p.write_text(prefix+s,encoding='utf-8')
print('V8 report written; files',len(files))
