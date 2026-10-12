import {it,expect} from 'vitest';
import {advanceMatcher,createMatcherState,scoreCandidates,matchingConfig,type MatcherState} from '../simulation/scenarioMatcher';
import type {PointCurve} from '../simulation/monitorCorrection';
import {decodeRleFrame,nearestFieldFrame,opticalDepth} from '../data/fieldsV7';
const curve=(c:number,slope=0,point=[11.5,-12,4.5]):PointCurve=>({timesS:[0,1800],temperatureC:[c,c+1800*slope],sampledFdsM:point,quantity:'GAS',source:'fixture',sourceSha256:'test'});
const curves={'HV-01-70MW':curve(60),'HV-01-100MW':curve(100),'HV-01-140MW':curve(140),'HV-02-100MW':curve(100),'LV-03-FIRE':curve(100)};
function run(value:(t:number)=>number,cs:Record<string,PointCurve>=curves){let state=createMatcherState();const decisions=[];for(let t=0;t<=25;t++){const r=advanceMatcher(state,{absoluteS:100+t,valueC:value(t),monitorId:'beam',source:'MOCK'},100+t,100,'HV-01-70MW',cs);state=r.state;decisions.push(r.decision);}return {state,decisions};}
it('缓慢变化不触发',()=>expect(run(t=>60+t*.3).decisions.every(x=>x.kind==='OBSERVE')).toBe(true));
it('单次异常恢复不切换',()=>expect(run(t=>t===4?100:60).decisions.some(x=>x.kind==='SWITCH')).toBe(false));
it('持续突变并连续候选确认后切同柜功率',()=>{const r=run(t=>t<4?60:100);expect(r.decisions.filter(x=>x.kind==='SWITCH')).toHaveLength(1);expect(r.decisions.find(x=>x.kind==='SWITCH')?.candidateId).toBe('HV-01-100MW');});
it('无候选不强切',()=>{const r=run(t=>t<4?60:190);expect(r.decisions.some(x=>x.kind==='UNMATCHED')).toBe(true);expect(r.decisions.some(x=>x.kind==='SWITCH')).toBe(false);});
it('接近候选拒绝',()=>expect(run(t=>t<4?60:100,{...curves,'HV-01-140MW':curve(100.2)}).decisions.some(x=>x.kind==='SWITCH')).toBe(false));
it('只吻合其他柜体不能自动换火源',()=>expect(run(t=>t<4?60:100,{'HV-01-70MW':curve(60),'HV-02-70MW':curve(100)}).decisions.some(x=>x.kind==='SWITCH')).toBe(false));
it('低压无同柜其它工况，不凭单点换柜',()=>{let state=createMatcherState();for(let t=0;t<25;t++){const r=advanceMatcher(state,{absoluteS:t,valueC:t<4?60:100,monitorId:'beam',source:'MOCK'},t,0,'LV-03-FIRE',{'LV-03-FIRE':curve(60),'LV-04-FIRE':curve(100)});state=r.state;expect(r.decision.kind).not.toBe('SWITCH');}});
it('同时刻比较，不挑候选碰巧同温的其它时刻',()=>{const h=[{absoluteS:160,valueC:100,monitorId:'beam',source:'MOCK' as const}];const s=scoreCandidates(h,{'HV-01-70MW':curve(40,1)},100,'HV-01-70MW');expect(s[0].maeC).toBe(0);expect(scoreCandidates(h,{'HV-01-70MW':curve(40,1)},0,'HV-01-70MW')[0].maeC).toBe(100);});
it('未来观测拒绝且不进入历史',()=>{const r=advanceMatcher(createMatcherState(),{absoluteS:161,valueC:100,monitorId:'beam',source:'MOCK'},160,100,'HV-01-70MW',curves);expect(r.state.history).toHaveLength(0);});
it('错点曲线拒绝',()=>expect(scoreCandidates([{absoluteS:100,valueC:100,monitorId:'beam',source:'MOCK'}],{'HV-01-100MW':curve(100,0,[12,-12,4.5])},100,'HV-01-70MW')).toEqual([]));
it('拖动大跳转/回放不触发突变',()=>{const a=advanceMatcher(createMatcherState(),{absoluteS:100,valueC:60,monitorId:'beam',source:'MOCK'},100,100,'HV-01-70MW',curves);const b=advanceMatcher(a.state,{absoluteS:160,valueC:100,monitorId:'beam',source:'MOCK'},160,100,'HV-01-70MW',curves);expect(b.state.eventAbsoluteS).toBeNull();expect(advanceMatcher(b.state,{absoluteS:140,valueC:150,monitorId:'beam',source:'MOCK'},160,100,'HV-01-70MW',curves).state).toBe(b.state);});
it('切换冷却期拒绝反复切换',()=>{const st:MatcherState={...createMatcherState(),lastSwitchAbsoluteS:104,eventAbsoluteS:104,history:[{absoluteS:104,valueC:100,monitorId:'beam',source:'MOCK'}],lastAbsoluteS:104};expect(advanceMatcher(st,{absoluteS:105,valueC:140,monitorId:'beam',source:'MOCK'},105,100,'HV-01-70MW',curves).decision.reason).toContain('冷却');});
it('RLE恢复含254/零长度run；尾部截断拒绝',()=>{expect(Array.from(decodeRleFrame(new Uint8Array([1,255,254,2,255,0,0,2]),{offset:0,length:8,timeS:0,maxByte:254},4))).toEqual([1,254,254,2]);expect(()=>decodeRleFrame(new Uint8Array([255]),{offset:0,length:1,timeS:0,maxByte:0},1)).toThrow();});
it('烟气与温度帧独立，烟气域外不伪造',()=>{const frames=[{timeS:0,offset:0,length:1,maxByte:0},{timeS:1.7,offset:1,length:1,maxByte:254}];expect(nearestFieldFrame(frames,1.8)).toBeNull();expect(nearestFieldFrame(frames,1)?.timeS).toBe(1.7);});
it('旧版烟气为光学不透明度，不能线性当浓度',()=>{expect(opticalDepth(0,.5)).toBe(0);expect(opticalDepth(127,.5)).toBeCloseTo(Math.log(2)/.5);expect(opticalDepth(254,.5)).toBeGreaterThan(10);});
it('匹配不改原数据',()=>{const before=JSON.stringify(curves);run(t=>t<4?60:100);expect(JSON.stringify(curves)).toBe(before);expect(matchingConfig.confirmS).toBeGreaterThan(0);});

it('当前FDS快速升温且MOCK固定偏差时不误报',()=>expect(run(t=>60+t*20+10,{'HV-01-70MW':curve(60,20),'HV-01-100MW':curve(100,20)}).decisions.every(x=>x.kind==='OBSERVE')).toBe(true));
