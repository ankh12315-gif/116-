/** V11 runtime configuration is server/fire-config.json; this module retains legacy adapters. */
/** 仅演示参数；没有设备/材料阈值依据，不构成真实消防判据。 */
const demoCabinet=import.meta.env.VITE_FIRE_CABINET??'HV-01';
const requestedPower=Number(import.meta.env.VITE_WINDOWED_POWER_MW);
const demoPower=[40,70,100,140].includes(requestedPower)?requestedPower:70;
export const fireSimulation = {
  defaultCabinetId: demoCabinet,
  highPowerMW: demoPower,
  enableRematching: true,
  // MOCK observations remain tied to initial source, independent of the selected prediction.
  mockObservationScenarioId: demoCabinet.startsWith('HV')?`${demoCabinet}-${demoPower}MW`:`${demoCabinet}-FIRE`,
  // Known-answer MOCK fixture. Target identity stays in the observation generator, never in matcher input.
  mockAnomaly: {enabled:false,atFdsS:30,targetScenarioId:'HV-01-140MW',
    profile:'ramp' as 'step'|'ramp'|'spike',transitionS:6,spikeDurationS:1},
  mockTriggerSequence: [{absoluteS:0,valueC:20},{absoluteS:2,valueC:22},{absoluteS:4,valueC:85},{absoluteS:5,valueC:130},{absoluteS:8,valueC:150}],
  triggerThresholdC: 120,
  triggerHoldS: 1,
  demoWarningC: 80,
  monitor: {id:'beam',fdsM:[11.5,-12,4.5] as [number,number,number], label:'梁下气相采样点（暂定）'},
  enableCorrection: true,
  mockBiasC: 0,
  correctionMaxDeltaC: 20,
  sensorMaxAgeS: 2,
  // 点修正，无空间外推；预报只冻结当前偏差，不使用未来 MOCK 样本。
  spatialCorrectionEnabled: false,
  sourceUrl: '/assets/monitor-v3/beam-curves.json',
} as const;

export function scenarioForCabinet(id:string,powerMW:number):string {
  if (/^LV-0[1-8]$/.test(id)) return `${id}-FIRE`;
  if (/^HV-0[12]$/.test(id) && [40,70,100,140].includes(powerMW)) return `${id}-${powerMW}MW`;
  throw new Error('自动工况配置无效：柜体或功率档位不存在');
}
