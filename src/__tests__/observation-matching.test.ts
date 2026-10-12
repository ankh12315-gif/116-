import {it,expect} from 'vitest';
import fs from 'node:fs';
import {mockObservationTemperature,type MockProfile} from '../simulation/mockObservation';
import {advanceMatcher,createMatcherState} from '../simulation/scenarioMatcher';
import {fireSimulation} from '../config/fireSimulation';
import type {PointCurve} from '../simulation/monitorCorrection';
const legacyFixture={...fireSimulation.mockAnomaly,enabled:true};
const curves=JSON.parse(fs.readFileSync('public/assets/monitor-v3/beam-curves.json','utf8')) as Record<string,PointCurve>;
function run(profile:MockProfile['profile']) {
 let state=createMatcherState(),current='HV-01-70MW';const decisions=[];
 for(let t=0;t<=180;t++){
  const value=mockObservationTemperature(curves,'HV-01-70MW',t,10,{...legacyFixture,profile});
  expect(value).not.toBeNull();
  const result=advanceMatcher(state,{absoluteS:t+100,valueC:value!,monitorId:'beam',source:'MOCK'},t+100,100,current,curves);
  state=result.state;if(result.decision.kind==='SWITCH')current=result.decision.candidateId!;
  if(result.decision.kind!=='OBSERVE'||result.decision.scores.length)decisions.push({t,...result.decision});
 }
 fs.writeFileSync(`docs/observation-matching/${profile}.json`,JSON.stringify({current,decisions},null,2));
 return {current,decisions};
}
it('真实同点同时刻骤变测试：目标存在，观测驱动唯一切换',()=>{const r=run('step');expect(r.current).toBe('HV-01-140MW');expect(r.decisions.filter(x=>x.kind==='SWITCH')).toHaveLength(1);});
it('真实同点同时刻渐变测试：无预定切换指令，仍匹配目标',()=>{const r=run('ramp');expect(r.current).toBe('HV-01-140MW');expect(r.decisions.filter(x=>x.kind==='SWITCH')).toHaveLength(1);});
it('单次尖峰恢复不切换',()=>{const r=run('spike');expect(r.current).toBe('HV-01-70MW');});
it('缺少目标曲线时MOCK不可用，不回退冒充异常读数',()=>{const library={...curves};delete library['HV-01-140MW'];expect(mockObservationTemperature(library,'HV-01-70MW',80,10,legacyFixture)).toBeNull();});
it('禁止跨场景、跨测点与跨边界构造成功测试',()=>{for(const patch of [{sceneMode:'windowless' as const},{sampledFdsM:[0,0,0]},{openingAtS:60}])expect(mockObservationTemperature({...curves,'HV-01-140MW':{...curves['HV-01-140MW'],...patch}},'HV-01-70MW',80,10,legacyFixture)).toBeNull();});

it('小步持续偏离也能触发并匹配，不要求每步突变',()=>{
 const curve=(v:number):PointCurve=>({timesS:[0,1800],temperatureC:[v,v],sampledFdsM:[11.5,-12,4.5],quantity:'GAS',source:'fixture',sourceSha256:'test'});
 const library={'HV-01-70MW':curve(60),'HV-01-100MW':curve(100)};
 let state=createMatcherState(),current='HV-01-70MW';let switches=0;
 for(let t=0;t<=80;t++){
  const value=t<10?70:Math.min(110,70+(t-10)*2);
  const r=advanceMatcher(state,{absoluteS:t,valueC:value,source:'MOCK',monitorId:'beam'},t,0,current,library);
  state=r.state;if(r.decision.kind==='SWITCH'){switches++;current=r.decision.candidateId!;}
 }
 expect(current).toBe('HV-01-100MW');expect(switches).toBe(1);
});
it('缺测造成间断不能继承候选连续确认',()=>{
 const st={...createMatcherState(),lastAbsoluteS:5,eventAbsoluteS:0,candidateId:'HV-01-140MW',confirmSinceS:0,history:[{absoluteS:5,valueC:100,source:'MOCK' as const,monitorId:'beam'}]};
 const r=advanceMatcher(st,{absoluteS:20,valueC:120,source:'MOCK',monitorId:'beam'},20,0,'HV-01-70MW',curves);
 expect(r.state.eventAbsoluteS).toBeNull();expect(r.state.confirmSinceS).toBeNull();
});
