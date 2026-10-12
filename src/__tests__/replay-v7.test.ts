import {it,expect} from 'vitest';
import fs from 'node:fs';
import {advanceMatcher,createMatcherState,type MatchDecision,type MatcherState} from '../simulation/scenarioMatcher';
import {pointTemperature,type PointCurve} from '../simulation/monitorCorrection';
const curves=JSON.parse(fs.readFileSync('public/assets/monitor-v3/beam-curves.json','utf8')) as Record<string,PointCurve>;
it('真实浏览器浮点采样回放与51秒同柜切换一致，拒绝把帧时间当传感器时间',()=>{
 const trace=JSON.parse(fs.readFileSync('docs/v7/browser-switch-log.json','utf8'));
 let state:MatcherState={...createMatcherState(),residualBaselineC:0},current='HV-01-70MW';const switched:number[]=[];
 for(const reading of trace.observations){const result=advanceMatcher(state,reading,reading.absoluteS,trace.origin,current,curves);state=result.state;if(result.decision.kind==='SWITCH'){current=result.decision.candidateId!;switched.push(reading.absoluteS-trace.origin);}}
 expect(current).toBe('HV-01-140MW');expect(switched).toHaveLength(1);expect(switched[0]).toBeCloseTo(51.02345,3);
});
function replay(initial:string,target:string,library:Record<string,PointCurve>,singleSpike=false,onset=60){let state=createMatcherState(),current=initial;const logs:({t:number;from:string}&MatchDecision)[]=[];let switches=0,wrong=0;
 for(let t=0;t<=180;t++){const truth=t<onset?curves[initial]:curves[target];const value=singleSpike?(t===60?150:pointTemperature(curves[initial],t)!):pointTemperature(truth,t)!;
 const r=advanceMatcher(state,{absoluteS:1000+t,valueC:value,monitorId:'beam',source:'MOCK'},1000+t,1000,current,library);state=r.state;
 if(r.decision.kind!=='OBSERVE'||r.decision.scores.length)logs.push({t,from:current,...r.decision});if(r.decision.kind==='SWITCH'){switches++;current=r.decision.candidateId!;if(current!==target)wrong++;}}
 const error=(id:string)=>Array.from({length:60},(_,i)=>Math.abs(pointTemperature(curves[id],181+i)!-pointTemperature(curves[target],181+i)!)).reduce((a,b)=>a+b,0)/60;
 return {initial,target,onset,current,switches,wrong,noReliableMatch:logs.some(x=>x.kind==='UNMATCHED'),beforeFutureMaeC:error(initial),afterFutureMaeC:error(current),evaluationWindowS:[181,240],decisionWindowEndS:180,logs};}
it('真实FDS同点因果回放与留出评估写入报告；保留失败案例',()=>{
 const hash=JSON.stringify(curves),known=[],heldout=[];
 for(const cabinet of ['HV-01','HV-02'])for(const power of [40,100,140]){const initial=cabinet+'-70MW',target=cabinet+`-${power}MW`;known.push(replay(initial,target,curves));const lib={...curves};delete lib[target];heldout.push(replay(initial,target,lib));}
 for(let i=1;i<=8;i++){const initial=`LV-0${i}-FIRE`,target=`LV-0${i%8+1}-FIRE`;known.push(replay(initial,target,curves));}
 const extra=[30,90].flatMap(t=>[100,140,40].map(p=>replay('HV-01-70MW',`HV-01-${p}MW`,curves,false,t)));
 const spike=replay('HV-01-70MW','HV-01-140MW',curves,true);expect(spike.switches).toBe(0);expect(known.filter(x=>x.initial.startsWith('LV')).every(x=>x.switches===0)).toBe(true);
 expect(known.find(x=>x.target==='HV-01-40MW')?.current).toBe('HV-01-40MW');expect(JSON.stringify(curves)).toBe(hash);
 fs.writeFileSync('docs/v7/matching-replay.json',JSON.stringify({note:'MOCK取已有同点FDS曲线；决策仅0–180秒观测，181–240秒仅事后评估。留出工况不在候选库；不代表未见CFD工况泛化。',known,heldout,extra,singleSpike:spike},null,2));
});
