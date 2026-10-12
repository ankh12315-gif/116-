export interface PointCurve { timesS:number[];temperatureC:number[];sampledFdsM:number[];source:string;sourceSha256:string;quantity:string;sceneMode?:'windowed'|'windowless';cabinetId?:string;openingAtS?:number;powerMW?:number|null; }
export interface SensorReading {source:'MOCK'|'SENSOR';absoluteS:number;valueC:number;monitorId:string;scenarioId:string;}
export function fdsRelativeTime(absoluteS:number,fireOriginAbsoluteS:number):number|null {
  if (!Number.isFinite(absoluteS)||!Number.isFinite(fireOriginAbsoluteS)||absoluteS<fireOriginAbsoluteS) return null;
  return absoluteS-fireOriginAbsoluteS;
}
/** 点曲线线性时间插值；三维场继续使用自身真实最近邻帧。越界不伪造。 */
export function pointTemperature(curve:PointCurve|undefined,t:number):number|null {
  if(!curve||!Number.isFinite(t)||!curve.timesS.length||t<curve.timesS[0]||t>curve.timesS[curve.timesS.length-1])return null;
  let lo=0,hi=curve.timesS.length-1;
  while(hi-lo>1){const m=(hi+lo)>>1;if(curve.timesS[m]<=t)lo=m;else hi=m;}
  const a=curve.timesS[lo],b=curve.timesS[hi];
  return a===b?curve.temperatureC[lo]:curve.temperatureC[lo]+(curve.temperatureC[hi]-curve.temperatureC[lo])*(t-a)/(b-a);
}
export function correctPoint(rawFdsC:number|null,reading:SensorReading|null,context:{absoluteS:number;scenarioId:string;monitorId:string;maxAgeS:number;maxDeltaC:number;enabled:boolean;referenceFdsC?:number|null}) {
  // 老样本必须有其自身时刻的FDS参照，不能拿过去的传感器和当前FDS做差。
  const reference=reading?.absoluteS===context.absoluteS?rawFdsC:context.referenceFdsC??null;
  if(rawFdsC===null||!Number.isFinite(rawFdsC)||reference===null||!Number.isFinite(reference)||!reading||!Number.isFinite(reading.valueC)||reading.scenarioId!==context.scenarioId||reading.monitorId!==context.monitorId||reading.absoluteS>context.absoluteS||context.absoluteS-reading.absoluteS>context.maxAgeS)
    return {rawFdsC,sensorC:null,deltaT:null,appliedDeltaC:0,correctedC:rawFdsC,errorBeforeC:null,errorAfterC:null,applied:false};
  const deltaT=reading.valueC-reference;
  const appliedDeltaC=context.enabled?Math.max(-context.maxDeltaC,Math.min(context.maxDeltaC,deltaT)):0;
  return {rawFdsC,sensorC:reading.valueC,deltaT,appliedDeltaC,correctedC:rawFdsC+appliedDeltaC,errorBeforeC:Math.abs(deltaT),errorAfterC:Math.abs(deltaT-appliedDeltaC),applied:context.enabled};
}
export function mockTriggerTemperature(sequence:readonly {absoluteS:number;valueC:number}[],t:number):number {
  if(t<=sequence[0].absoluteS)return sequence[0].valueC;
  for(let i=1;i<sequence.length;i++){const a=sequence[i-1],b=sequence[i];if(t<=b.absoluteS)return a.valueC+(b.valueC-a.valueC)*(t-a.absoluteS)/(b.absoluteS-a.absoluteS);}
  return sequence[sequence.length-1].valueC;
}
export function evaluateTrigger(state:{aboveSinceS:number|null;fired:boolean},absoluteS:number,temperatureC:number,thresholdC:number,holdS:number) {
  if(state.fired)return state;
  if(!Number.isFinite(temperatureC)||temperatureC<thresholdC)return {aboveSinceS:null,fired:false};
  const aboveSinceS=state.aboveSinceS??absoluteS;
  return {aboveSinceS,fired:absoluteS-aboveSinceS>=holdS};
}
