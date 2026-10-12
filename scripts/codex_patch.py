from pathlib import Path
root = Path(__file__).resolve().parents[1]
def edit(name, fn):
    p=root/name
    p.write_text(fn(p.read_text(encoding='utf-8')), encoding='utf-8')
def coords(s):
    start=s.index('/**\n * `scaleC` 语义判别')
    end=s.index('/** 残差自检的诊断结论 */', start)
    return s[:start]+'''/** 量化语义只接受资产显式声明；缺失或非法时拒绝解码。 */
export function resolveScaleMode(
  q: { scaleC: number; scaleMode?: QuantScaleMode } | undefined | null,
): QuantScaleMode {
  if (q?.scaleMode === 'SPAN' || q?.scaleMode === 'PER_LSB') return q.scaleMode;
  throw new Error('切片资产缺少或无效 manifest.scaleMode 字段，拒绝猜测量化语义');
}

export function quantSpecFromSlice(meta: SliceMeta): QuantSpec {
  const q = meta.quantization;
  const mode = resolveScaleMode(q);
  if (!Number.isFinite(q.baseC) || !Number.isFinite(q.scaleC) || q.scaleC <= 0 || q.bits !== 8) {
    throw new Error(`切片量化参数无效：${meta.asset}`);
  }
  return { baseC: q.baseC, scaleC: q.scaleC, bits: q.bits, mode };
}

/** 状态栏、图例、说明抽屉共用当前切片的真实量化描述。 */
export function describeQuantization(meta: SliceMeta) {
  const spec = quantSpecFromSlice(meta);
  const domain = sliceQuantDomain(meta);
  const stepC = dequantizeTemp(1, spec.baseC, spec.scaleC, spec.mode) - spec.baseC;
  return {
    ...domain, stepC, mode: spec.mode, note: quantNote(spec), frameCount: meta.frameCount,
    formula: spec.mode === 'SPAN'
      ? `T = ${spec.baseC} + (byte / 255) × ${spec.scaleC} ℃`
      : `T = ${spec.baseC} + byte × ${spec.scaleC.toFixed(4)} ℃`,
    clipping: `低端${meta.dataMinC < domain.minC ? '存在截断' : '未见截断证据'}；高端${meta.dataMaxC > domain.maxC ? '存在饱和截断' : '未见饱和证据'}`,
  };
}

'''+s[end:]
edit('src/utils/coords.ts',coords)
def tests(s):
    s=s.replace('  SCALE_MODE_THRESHOLD,\n','').replace('  hasScaleContradiction,\n','')
    a=s.index("describe('resolveScaleMode：")
    b=s.index('/**\n * 🔴 P0 回归哨兵',a)
    return s[:a]+'''describe('resolveScaleMode：显式字段契约', () => {
  it('仅按显式字段，scaleC 量级不得参与判断', () => {
    expect(resolveScaleMode({ scaleC: 7.84, scaleMode: 'SPAN' })).toBe('SPAN');
    expect(resolveScaleMode({ scaleC: 780, scaleMode: 'PER_LSB' })).toBe('PER_LSB');
  });
  it.each([undefined, null, SPAN_Q, PER_LSB_Q, {scaleC: -780}, {scaleC: NaN}])('缺少模式必须失败 %j', (q) => {
    expect(() => resolveScaleMode(q)).toThrow('manifest.scaleMode');
  });
  it('拒绝未知模式', () => {
    expect(() => resolveScaleMode({scaleC: 780, scaleMode: 'PER_SLICE' as never})).toThrow('manifest.scaleMode');
  });
});

'''+s[b:]
edit('src/__tests__/coords.test.ts',tests)
edit('src/types/domain.ts',lambda s:s.replace('export interface ScenarioDataset {','export interface ScenarioDataset {\n  scaleMode?: QuantScaleMode;'))
edit('src/data/scenarioProvider.ts', lambda s:s.replace("const BASE =", "import { quantSpecFromSlice, resolveScaleMode } from '../utils/coords';\n\nconst BASE =").replace('    const [series, hrrRaw, releaseProfile, volumeManifest]', '''    validateDatasetQuantization(manifest, scenarioId);

    const [series, hrrRaw, releaseProfile, volumeManifest]''').replace('    // manifest.json 里的字段', '''    if (volumeManifest) {
      resolveScaleMode(volumeManifest.quantization);
      for (const v of volumeManifest.volumes) resolveScaleMode(v.quantization);
    }
    // manifest.json 里的字段'''))
edit('src/data/scenarioProvider.ts', lambda s:s+'''
/** 在进入 React/Three 渲染前验证资产契约，让错误由 store 捕获。 */
export function validateDatasetQuantization(manifest: ScenarioDataset, scenarioId: string): void {
  if (manifest.scenarioId !== scenarioId) throw new Error('工况资产身份不一致');
  const mode = resolveScaleMode({scaleC: 0, scaleMode: manifest.scaleMode});
  for (const sl of manifest.slices ?? []) {
    if (quantSpecFromSlice(sl).mode !== mode) throw new Error(`manifest.scaleMode 与切片不一致：${sl.asset}`);
  }
}
''')
edit('src/ui/StatusBar.tsx',lambda s:s.replace('import { SLICE_CMAP_NOTE }', 'import { describeQuantization }').replace('  const sliceTimes =','  const quant = slices[0] ? describeQuantization(slices[0]) : null;\n  const sliceTimes =').replace('title="标量序列为 201 点线性插值，切片为 101 帧最近邻取样，两套时间栅格互不相同"','title={`标量 ${series?.timesS.length ?? 0} 点线性插值，切片 ${quant?.frameCount ?? 0} 帧最近邻取样，两套时间栅格互不相同`}').replace('{SLICE_CMAP_NOTE}','{quant?.note}').replace("detail: hrr ? '抽稀/全分辨率序列不直接绘制，仅显示峰值标量' : '当前工况无 HRR 数据',","detail: hrr?.sampling === 'FULL_RESOLUTION' ? '全分辨率曲线已接入' : '当前工况无全分辨率 HRR 数据',").replace("    items.push({\n      label: 'HRR 曲线',", "    if (hrr?.sampling !== 'FULL_RESOLUTION') items.push({\n      label: 'HRR 曲线',"))
edit('src/ui/DisclaimerDrawer.tsx',lambda s:s.replace('import { NO_DATA_LABEL }','import { NO_DATA_LABEL, describeQuantization }').replace('  const panelRef =','  const slices = useFireStore((s) => s.slices);\n  const quant = slices[0] ? describeQuantization(slices[0]) : null;\n  const panelRef =').replace('切片二进制为 8bit 量化（<code style={CODE}>T = 20 + b × 3.0588 ℃</code>），\n            定义域 20–800℃，<Strong>上下两端都存在截断</Strong>。','切片二进制为 8bit 量化（<code style={CODE}>{quant?.formula ?? \'数据不可用\'}</code>），\n            定义域 {quant ? `${quant.minC}–${quant.maxC}℃` : \'不可用\'}，{quant?.note}。\n            <Strong>{quant?.clipping}</Strong>。'))
edit('scripts/convert_s3d.py',lambda s:s.replace('"scaleC": SCALE_C, "bits": 8}', '"scaleC": SCALE_C, "bits": 8, "scaleMode": "PER_LSB"}'))
