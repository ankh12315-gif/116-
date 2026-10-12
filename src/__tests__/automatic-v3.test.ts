import {describe,it,expect} from 'vitest';
import * as THREE from 'three';
import {scenarioForCabinet,fireSimulation} from '../config/fireSimulation';
import {correctPoint,evaluateTrigger,fdsRelativeTime,mockTriggerTemperature,pointTemperature} from '../simulation/monitorCorrection';
import {surfaceMatrix} from '../utils/surfaceGeometry';
import {fdsToThree} from '../utils/coords';
const ctx={absoluteS:106,scenarioId:'HV-01-70MW',monitorId:'beam',maxAgeS:2,maxDeltaC:20,enabled:true};
const reading={source:'MOCK' as const,absoluteS:106,scenarioId:'HV-01-70MW',monitorId:'beam',valueC:90};
describe('V3 自动匹配',()=>{
 for(let i=1;i<=8;i++)it(`LV-0${i}`,()=>expect(scenarioForCabinet(`LV-0${i}`,70)).toBe(`LV-0${i}-FIRE`));
 for(const id of ['HV-01','HV-02'])for(const mw of [40,70,100,140])it(`${id}-${mw}`,()=>expect(scenarioForCabinet(id,mw)).toBe(`${id}-${mw}MW`));
 it('拒绝无效柜位/功率',()=>{expect(()=>scenarioForCabinet('HV-03',70)).toThrow();expect(()=>scenarioForCabinet('HV-01',80)).toThrow();});
 it('超阈值必须持续，回落复位，一次锁定',()=>{let d={aboveSinceS:null as number|null,fired:false};d=evaluateTrigger(d,5,130,120,1);expect(d.fired).toBe(false);d=evaluateTrigger(d,5.5,90,120,1);expect(d.aboveSinceS).toBe(null);d=evaluateTrigger(d,6,130,120,1);d=evaluateTrigger(d,7,130,120,1);expect(d.fired).toBe(true);expect(evaluateTrigger(d,8,20,120,1).fired).toBe(true);});
 it('MOCK demo在约6秒自动触发，HRR不作温度',()=>{let d={aboveSinceS:null as number|null,fired:false};for(let t=0;t<=7;t+=.1)d=evaluateTrigger(d,t,mockTriggerTemperature(fireSimulation.mockTriggerSequence,t),fireSimulation.triggerThresholdC,fireSimulation.triggerHoldS);expect(d.fired).toBe(true);expect(fireSimulation.triggerThresholdC).not.toBe(fireSimulation.highPowerMW);});
});
describe('单点修正与时间来源',()=>{
 it('绝对106减触发100等于FDS6；禁止任意同名时间',()=>{expect(fdsRelativeTime(106,100)).toBe(6);expect(fdsRelativeTime(99,100)).toBe(null);expect(fdsRelativeTime(NaN,100)).toBe(null);});
 it('80/90得到点修正90，原值保留且误差10到0',()=>{const result=correctPoint(80,reading,ctx);expect(result).toMatchObject({rawFdsC:80,sensorC:90,deltaT:10,correctedC:90,errorBeforeC:10,errorAfterC:0});expect(reading.valueC).toBe(90);});
 it('异常偏差有界',()=>expect(correctPoint(80,{...reading,valueC:300},ctx)).toMatchObject({appliedDeltaC:20,correctedC:100,errorAfterC:200}));
 it('禁用返回原始温度',()=>expect(correctPoint(80,reading,{...ctx,enabled:false}).correctedC).toBe(80));
 it('2秒内旧样本按其自身FDS参考70求偏差，不与当前80直接做差',()=>{const old={...reading,absoluteS:104,valueC:80};expect(correctPoint(80,old,ctx).applied).toBe(false);expect(correctPoint(80,old,{...ctx,referenceFdsC:70})).toMatchObject({deltaT:10,correctedC:90,errorBeforeC:10,errorAfterC:0});});
 for(const bad of [{...reading,absoluteS:103},{...reading,absoluteS:107},{...reading,monitorId:'wall'},{...reading,scenarioId:'LV-01-FIRE'},{...reading,valueC:NaN}])it(`拒绝错时/错点/错工况/异常 ${JSON.stringify(bad)}`,()=>expect(correctPoint(80,bad,ctx).applied).toBe(false));
 it('缺测不编造',()=>expect(correctPoint(null,reading,ctx).correctedC).toBe(null));
 it('未来只冻结当前偏差，不借用未来传感器读数',()=>{const current=correctPoint(80,reading,ctx);const futureRaw=95;expect(futureRaw+current.appliedDeltaC).toBe(105);expect(correctPoint(80,{...reading,absoluteS:136},ctx).applied).toBe(false);});
 it('点时间插值保留数组，越界不可用',()=>{const c={timesS:[0,2],temperatureC:[20,80],sampledFdsM:[11.5,-12,4.5],source:'test',sourceSha256:'test',quantity:'GAS'};expect(pointTemperature(c,1)).toBe(50);expect(pointTemperature(c,3)).toBe(null);expect(c.temperatureC).toEqual([20,80]);});
});
describe('真实面片轴映射',()=>{
 it('温度纹理UV最小角对准真实umin/vmin，不二次镜像',()=>{
   const cases=[{xb:[2,8,-17,1,1,1],min:[2,-17,1],max:[8,1,1]}, {xb:[2,2,-17,1,0,6],min:[2,-17,0],max:[2,1,6]}, {xb:[0,13,-12,-12,0,6],min:[0,-12,0],max:[13,-12,6]}];
   for(const c of cases){const m=surfaceMatrix(c.xb);const a=new THREE.Vector3(-.5,-.5,0).applyMatrix4(m),b=new THREE.Vector3(.5,.5,0).applyMatrix4(m);fdsToThree(c.min[0],c.min[1],c.min[2]).forEach((v,i)=>expect(a.getComponent(i)).toBeCloseTo(v,8));fdsToThree(c.max[0],c.max[1],c.max[2]).forEach((v,i)=>expect(b.getComponent(i)).toBeCloseTo(v,8));}
 });
 for(const xb of [[2,2,-17,1,0,6],[0,13,-12,-12,0,6],[0,13,-17,1,6,6]])it(`XB ${xb}`,()=>{const matrix=surfaceMatrix(xb);const corners=[[-.5,-.5,0],[-.5,.5,0],[.5,-.5,0],[.5,.5,0]].map(p=>new THREE.Vector3(...p).applyMatrix4(matrix));const box=new THREE.Box3().setFromPoints(corners);const a=fdsToThree(xb[0],xb[2],xb[4]),b=fdsToThree(xb[1],xb[3],xb[5]);for(let i=0;i<3;i++){expect(box.min.getComponent(i)).toBeCloseTo(Math.min(a[i],b[i]),8);expect(box.max.getComponent(i)).toBeCloseTo(Math.max(a[i],b[i]),8);}});
});
