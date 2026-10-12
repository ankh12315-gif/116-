import type {PointCurve,SensorReading} from './monitorCorrection';
import {fdsRelativeTime,pointTemperature} from './monitorCorrection';
export interface SensorSource {
  /** 后续用有柜位ID/绝对时间戳的真实接入替换本接口；拒绝错时、错点、错工况在修正层处理。 */
  read(context:{absoluteS:number;fireOriginAbsoluteS:number;scenarioId:string;monitorId:string;curve:PointCurve|undefined}):SensorReading|null;
}
export function mockSensorSource(biasC:number):SensorSource {
  return {read(c){const relative=fdsRelativeTime(c.absoluteS,c.fireOriginAbsoluteS);const baseline=relative===null?null:pointTemperature(c.curve,relative);
    return baseline===null?null:{source:'MOCK',absoluteS:c.absoluteS,valueC:baseline+biasC,scenarioId:c.scenarioId,monitorId:c.monitorId};}};
}
