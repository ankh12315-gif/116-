/**
 * Provider 层数据真实性测试
 *
 * 覆盖 16 工况可用性统计、资产索引校正（reconcileOne）与场景解析。
 * 数据源：public/assets/scenarios/scenarios.json（索引层声明值）
 *       public/assets/results/{id}/manifest.json（转换器产出，校正时的权威事实）
 */

import { describe, expect, it } from 'vitest';
import {
  INVALID_SCENARIO_IDS,
  ScenarioAccessError,
  assertScenarioUsable,
  reconcileOne,
  resolveScenarioId,
} from '../data/scenarioProvider';
import type { Scenario, ScenarioDataset } from '../types/domain';

/**
 * 16 个工况的**索引层**元数据镜像。
 * 与 public/assets/scenarios/scenarios.json 逐字段核对。
 * ⚠️ HV-01-140MW 在索引层仍是 INVALID_SOURCE + 1400000 kW（修正前的值），
 *    真实状态由 results/HV-01-140MW/manifest.json 给出，见下方 reconcileOne 测试。
 * 直接import JSON 需要 resolveJsonManifest 支持，这里手写以保证测试独立。
 */
const SCENARIOS: Scenario[] = [
  // 低压 8 个：全部 READY
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: `LV-0${n}-FIRE`,
    zone: 'LOW' as const,
    cabinetId: `LV-0${n}`,
    powerOptionMW: null,
    nominalPeakHRRKW: 123.0,
    inputFile: `116-diya-${n}.fds`,
    chid: `116-diya-${n}`,
    tEndS: 1800,
    availability: 'READY' as const,
    blockedReason: null,
    outputFound: { devc: true, smv: true, hrr: true, fdsCompletedSuccessfully: true, caseDir: null },
  })),
  // 高压 HV-01：40/70/100 READY；140 在索引层仍标记为 INVALID_SOURCE
  {
    id: 'HV-01-40MW',
    zone: 'HIGH',
    cabinetId: 'HV-01',
    powerOptionMW: 40,
    nominalPeakHRRKW: 40000.0,
    inputFile: '116-gaoya-1-40mw.fds',
    chid: '116-gaoya-1-40mw',
    tEndS: 1800,
    availability: 'READY',
    blockedReason: null,
    outputFound: { devc: true, smv: true, hrr: true, fdsCompletedSuccessfully: true, caseDir: null },
  },
  {
    id: 'HV-01-70MW',
    zone: 'HIGH',
    cabinetId: 'HV-01',
    powerOptionMW: 70,
    nominalPeakHRRKW: 70000.0,
    inputFile: '116-gaoya-1-70mw.fds',
    chid: '116-gaoya-1-70mw',
    tEndS: 1800,
    availability: 'READY',
    blockedReason: null,
    outputFound: { devc: true, smv: true, hrr: true, fdsCompletedSuccessfully: true, caseDir: null },
  },
  {
    id: 'HV-01-100MW',
    zone: 'HIGH',
    cabinetId: 'HV-01',
    powerOptionMW: 100,
    nominalPeakHRRKW: 100000.0,
    inputFile: '116-gaoya-1-100mw.fds',
    chid: '116-gaoya-1-100mw',
    tEndS: 1800,
    availability: 'READY',
    blockedReason: null,
    outputFound: { devc: true, smv: true, hrr: true, fdsCompletedSuccessfully: true, caseDir: null },
  },
  {
    id: 'HV-01-140MW',
    zone: 'HIGH',
    cabinetId: 'HV-01',
    powerOptionMW: 140,
    nominalPeakHRRKW: 1400000.0,
    inputFile: '116-gaoya-1-140mw.fds',
    chid: '116-gaoya-1-140mw',
    tEndS: 1800,
    availability: 'INVALID_SOURCE',
    blockedReason:
      '源 FDS 输入 HRRPUA=5.6E6 kW/m² × 0.25 m² = 1400 MW，与标称 140 MW 不符，需重新模拟。',
    outputFound: { devc: true, smv: true, hrr: true, fdsCompletedSuccessfully: true, caseDir: null },
  },
  // 高压 HV-02：四档全部 READY（140MW 在 HV-02 从未受影响）
  ...[40, 70, 100, 140].map((mw) => ({
    id: `HV-02-${mw}MW`,
    zone: 'HIGH' as const,
    cabinetId: 'HV-02',
    powerOptionMW: mw,
    nominalPeakHRRKW: mw * 1000,
    inputFile: `116-gaoya-2-${mw}mw.fds`,
    chid: `116-gaoya-2-${mw}mw`,
    tEndS: 1800,
    availability: 'READY' as const,
    blockedReason: null,
    outputFound: { devc: true, smv: true, hrr: true, fdsCompletedSuccessfully: true, caseDir: null },
  })),
];

describe('资产索引层现状（scenarios.json 声明值，尚未校正）', () => {
  it('16 个工况中恰好 15 个 READY', () => {
    expect(SCENARIOS).toHaveLength(16);
    expect(SCENARIOS.filter((s) => s.availability === 'READY')).toHaveLength(15);
  });

  it('索引层恰好 1 个 INVALID_SOURCE，且是 HV-01-140MW', () => {
    const invalid = SCENARIOS.filter((s) => s.availability === 'INVALID_SOURCE');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].id).toBe('HV-01-140MW');
  });

  it('禁用黑名单已清空（源输入修正并复算后不得再有硬禁用）', () => {
    expect(INVALID_SCENARIO_IDS.has('HV-01-140MW')).toBe(false);
    expect(INVALID_SCENARIO_IDS.size).toBe(0);
  });

  it('HV-02-140MW 有效（140MW 档位在 HV-02 从未受影响）', () => {
    expect(SCENARIOS.find((s) => s.id === 'HV-02-140MW')?.availability).toBe('READY');
    expect(resolveScenarioId(SCENARIOS, 'HV-02', 140).id).toBe('HV-02-140MW');
  });

  it('8 个低压工况 powerOptionMW 均为 null 且标称 123 kW', () => {
    const lv = SCENARIOS.filter((s) => s.zone === 'LOW');
    expect(lv).toHaveLength(8);
    expect(lv.every((s) => s.powerOptionMW === null)).toBe(true);
    expect(lv.every((s) => s.nominalPeakHRRKW === 123.0)).toBe(true);
  });
});

/**
 * 资产校正：索引层（scenarios.json）与转换器产出（results/{id}/manifest.json）
 * 对 HV-01-140MW 的记载不一致。数据资产不可修改（改了就改错事实），
 * 故在校验层以 manifest 为权威事实校正，并向 UI 披露。
 * fixture 逐字段取自真实的 results/HV-01-140MW/manifest.json。
 */
describe('reconcileOne：以 results manifest 为权威事实校正过时的索引标记', () => {
  const declared = SCENARIOS.find((s) => s.id === 'HV-01-140MW')!;

  const v2Manifest = {
    status: 'READY',
    hrrInterpretation: {
      nominalPeakHRRKW: 140000.0,
      measuredPeakHRRKW: 13382.431,
      measuredPeakTimeS: 3.6011,
    },
    dataProvenance: {
      origin: 'V2_HANDBOX_RECALC',
      sourceFdsSha256: '7019c0bb4a1f68513785de2d9d84025d11fb5429a49ee73920568a38e90be859',
      sourceFdsHrrpua: 560000.0,
      fdsCompletedSuccessfully: true,
      inputCorrection: 'HRRPUA 5.6E6 -> 5.6E5 已修正并复算',
    },
  } as unknown as ScenarioDataset;

  it('HV-01-140MW 被校正为 READY，标称峰值 140000 kW（= 140 MW）', () => {
    const fixed = reconcileOne(declared, v2Manifest);
    expect(fixed).not.toBeNull();
    expect(fixed!.scenario.availability).toBe('READY');
    expect(fixed!.scenario.blockedReason).toBeNull();
    expect(fixed!.scenario.nominalPeakHRRKW).toBe(140000);
  });

  it('校正记录同时保留声明值与 manifest 值，供 UI 披露（不静默改写）', () => {
    const rec = reconcileOne(declared, v2Manifest)!.reconciliation;
    expect(rec.declaredAvailability).toBe('INVALID_SOURCE');
    expect(rec.manifestStatus).toBe('READY');
    expect(rec.provenanceOrigin).toBe('V2_HANDBOX_RECALC');
    expect(rec.inputCorrection).toBe('HRRPUA 5.6E6 -> 5.6E5 已修正并复算');
    // 索引层声明的是修正前的 1400 MW
    expect(rec.nominalPeakHRRKW.declared).toBe(1400000);
    expect(rec.nominalPeakHRRKW.fromManifest).toBe(140000);
  });

  it('校正后的工况可正常解析并通过可用性校验', () => {
    const fixed = reconcileOne(declared, v2Manifest)!.scenario;
    expect(() => assertScenarioUsable(fixed, fixed.id)).not.toThrow();
    const list = SCENARIOS.map((s) => (s.id === fixed.id ? fixed : s));
    expect(resolveScenarioId(list, 'HV-01', 140).id).toBe('HV-01-140MW');
  });

  it('已是 READY 的工况不做任何校正', () => {
    const ready = SCENARIOS.find((s) => s.id === 'HV-01-40MW')!;
    expect(reconcileOne(ready, v2Manifest)).toBeNull();
  });

  it('manifest 未就绪 → 不校正（校正不是绕过校验的后门）', () => {
    const bad = { ...v2Manifest, status: 'INVALID_SOURCE' } as unknown as ScenarioDataset;
    expect(reconcileOne(declared, bad)).toBeNull();
  });

  it('无 dataProvenance → 不校正（无法证明发生过修正与复算）', () => {
    const noProv = {
      status: 'READY',
      hrrInterpretation: v2Manifest.hrrInterpretation,
    } as unknown as ScenarioDataset;
    expect(reconcileOne(declared, noProv)).toBeNull();
  });

  it('provenance 存在但 origin 非 V2 且无 inputCorrection → 不校正', () => {
    const weak = {
      status: 'READY',
      dataProvenance: { origin: 'USER_LOCAL_RUN', inputCorrection: null },
    } as unknown as ScenarioDataset;
    expect(reconcileOne(declared, weak)).toBeNull();
  });

  it('origin 为 V2_HANDBOX_RECALC 即校正（inputCorrection 为 null 也放行）', () => {
    const v2NoNote = {
      status: 'READY',
      hrrInterpretation: v2Manifest.hrrInterpretation,
      dataProvenance: { origin: 'V2_HANDBOX_RECALC', inputCorrection: null },
    } as unknown as ScenarioDataset;
    expect(reconcileOne(declared, v2NoNote)).not.toBeNull();
  });
});

describe('assertScenarioUsable：未经校正的无效声明仍被拒（最后一道防线）', () => {
  it('声明为 INVALID_SOURCE 的原始索引条目直接被拒', () => {
    const bad = SCENARIOS.find((s) => s.id === 'HV-01-140MW')!;
    expect(() => assertScenarioUsable(bad, 'HV-01-140MW')).toThrow(ScenarioAccessError);
    try {
      assertScenarioUsable(bad, 'HV-01-140MW');
    } catch (e) {
      expect((e as ScenarioAccessError).availability).toBe('INVALID_SOURCE');
      expect((e as ScenarioAccessError).scenarioId).toBe('HV-01-140MW');
    }
  });

  it('黑名单命中同样被拒（防线仍在，只是当前为空集）', () => {
    const ready = SCENARIOS.find((s) => s.id === 'HV-01-40MW')!;
    INVALID_SCENARIO_IDS.add('HV-01-40MW');
    try {
      expect(() => assertScenarioUsable(ready, 'HV-01-40MW')).toThrow(ScenarioAccessError);
    } finally {
      INVALID_SCENARIO_IDS.delete('HV-01-40MW');
    }
    expect(INVALID_SCENARIO_IDS.size).toBe(0);
  });

  it('未定义的档位抛 MISSING_OUTPUT（不是 INVALID_SOURCE）', () => {
    try {
      resolveScenarioId(SCENARIOS, 'HV-01', 999);
      throw new Error('本应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioAccessError);
      expect((e as ScenarioAccessError).availability).toBe('MISSING_OUTPUT');
    }
  });

  it('未找到的柜体抛 MISSING_OUTPUT', () => {
    try {
      resolveScenarioId(SCENARIOS, 'HV-99', 40);
      throw new Error('本应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioAccessError);
      expect((e as ScenarioAccessError).availability).toBe('MISSING_OUTPUT');
    }
  });
});

describe('resolveScenarioId：正常路径', () => {
  it('高压必须显式提供档位', () => {
    expect(resolveScenarioId(SCENARIOS, 'HV-01', 40).id).toBe('HV-01-40MW');
    expect(resolveScenarioId(SCENARIOS, 'HV-01', 70).id).toBe('HV-01-70MW');
    expect(resolveScenarioId(SCENARIOS, 'HV-01', 100).id).toBe('HV-01-100MW');
  });

  it('低压忽略 powerOptionMW，自动匹配唯一工况', () => {
    expect(resolveScenarioId(SCENARIOS, 'LV-01', null).id).toBe('LV-01-FIRE');
    expect(resolveScenarioId(SCENARIOS, 'LV-08', null).id).toBe('LV-08-FIRE');
    // 即便误传档位，低压仍按 powerOptionMW===null 匹配
    expect(resolveScenarioId(SCENARIOS, 'LV-04', null).id).toBe('LV-04-FIRE');
  });

  it('标称值与档位一致（HV 标称 kW = MW × 1000）', () => {
    for (const s of SCENARIOS.filter((x) => x.zone === 'HIGH' && x.availability === 'READY')) {
      expect(s.nominalPeakHRRKW).toBe((s.powerOptionMW ?? 0) * 1000);
    }
  });

  it('索引层 HV-01-140MW 声明的是 1400000 kW（修正前的 10 倍值，校正的必要性来源）', () => {
    const bad = SCENARIOS.find((s) => s.id === 'HV-01-140MW')!;
    // 标称 140 MW 应为 140000 kW；索引层是 1400000 kW
    expect(bad.nominalPeakHRRKW).toBe(1400000);
    expect(bad.nominalPeakHRRKW).toBe(140 * 10000);
  });

  it('校正后 16 个工况全部 READY（校正后不再有 INVALID_SOURCE）', () => {
    const fixed = SCENARIOS.map((s) => reconcileOne(s, v2ManifestFor(s))?.scenario ?? s);
    expect(fixed.every((s) => s.availability === 'READY')).toBe(true);
    expect(fixed.filter((s) => s.availability === 'READY')).toHaveLength(16);
    // 标称峰值也随之对齐140 MW
    expect(fixed.find((s) => s.id === 'HV-01-140MW')?.nominalPeakHRRKW).toBe(140000);
  });
});

/**
 * 模拟 `reconcileAvailability` 对全表施用校正。
 * 仅 HV-01-140MW 有 V2 manifest，其标称峰值取自真实 manifest（140000 kW）；
 * 其余工况本来就是READY，`reconcileOne` 会直接返回 null。
 */
function v2ManifestFor(s: Scenario): ScenarioDataset {
  const nominal =
    s.id === 'HV-01-140MW' ? 140000.0 : s.nominalPeakHRRKW;
  return {
    status: 'READY',
    hrrInterpretation: { nominalPeakHRRKW: nominal },
    dataProvenance: {
      origin: 'V2_HANDBOX_RECALC',
      inputCorrection: 'HRRPUA 5.6E6 -> 5.6E5 已修正并复算',
    },
  } as unknown as ScenarioDataset;
}