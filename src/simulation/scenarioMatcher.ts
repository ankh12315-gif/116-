import {pointTemperature,type PointCurve} from './monitorCorrection';
export interface Observation {absoluteS:number;valueC:number;monitorId:string;source:'MOCK'|'SENSOR';sceneMode?:'windowed'|'windowless'}
export interface MatchingConfig {windowS:number;jumpC:number;deviationC:number;confirmS:number;minSamples:number;maxGapS:number;maxMaeC:number;minImprovementC:number;minRelativeImprovement:number;marginC:number;cooldownS:number;monitorId:string;point:number[];sceneMode?:'windowed'|'windowless';persistentSamples?:number;persistentRequired?:number;initialResidualBiasC?:number}
export const matchingConfig:MatchingConfig={persistentSamples:5,persistentRequired:4,windowS:8,jumpC:12,deviationC:8,confirmS:6,minSamples:5,maxGapS:2.5,maxMaeC:5,minImprovementC:6,minRelativeImprovement:.4,marginC:2,cooldownS:30,monitorId:'beam',point:[11.5,-12,4.5]};
export interface CandidateScore {id:string;maeC:number;rmseC:number;currentErrorC:number;slopeErrorCPerS:number;score:number;allowed:boolean}
export interface MatchDecision {kind:'OBSERVE'|'UNMATCHED'|'SWITCH';reason:string;candidateId?:string;scores:CandidateScore[];eventAbsoluteS:number|null}
export interface MatcherState {history:Observation[];eventAbsoluteS:number|null;confirmSinceS:number|null;candidateId:string|null;lastSwitchAbsoluteS:number;lastAbsoluteS:number;residualBaselineC?:number}
export function createMatcherState():MatcherState{return {history:[],eventAbsoluteS:null,confirmSinceS:null,candidateId:null,lastSwitchAbsoluteS:-Infinity,lastAbsoluteS:-Infinity};}
export function scoreCandidates(history:Observation[],curves:Record<string,PointCurve>,origin:number,currentId:string,cfg=matchingConfig):CandidateScore[]{
 const currentCurve=curves[currentId],mode=cfg.sceneMode??'windowed',cabinet=currentCurve?.cabinetId??currentId.split('-').slice(0,2).join('-');return Object.entries(curves).flatMap(([id,curve])=>{
  if((curve.sceneMode??'windowed')!==mode)return [];
  if(curve.sampledFdsM.length!==3||curve.sampledFdsM.some((v,i)=>Math.abs(v-cfg.point[i])>1e-6))return [];
  const predicted=history.map(x=>pointTemperature(curve,x.absoluteS-origin));if(predicted.some(x=>x===null)||!history.length)return [];
  const errors=predicted.map((x,i)=>x!-history[i].valueC),maeC=errors.reduce((s,x)=>s+Math.abs(x),0)/errors.length,rmseC=Math.sqrt(errors.reduce((s,x)=>s+x*x,0)/errors.length);
  const dt=history[history.length-1].absoluteS-history[0].absoluteS;
  const slopeErrorCPerS=dt>0?Math.abs((predicted[predicted.length-1]!-predicted[0]!-(history[history.length-1].valueC-history[0].valueC))/dt):0;
  const sameCabinet=(curve.cabinetId??id.split('-').slice(0,2).join('-'))===cabinet;
  const sameBoundary=curve.openingAtS===currentCurve?.openingAtS;
  const currentErrorC=Math.abs(errors[errors.length-1]);return [{id,maeC,rmseC,currentErrorC,slopeErrorCPerS,score:.5*maeC+.25*rmseC+.15*currentErrorC+.1*slopeErrorCPerS,allowed:id===currentId||(sameCabinet&&sameBoundary&&cabinet.startsWith('HV'))}];
 }).sort((a,b)=>a.score-b.score);
}
/** Causal observations only, fixed origin, no best-frame/time-shift search. Cross-cabinet candidates logged but never automatically authorized by a single point. */
export function advanceMatcher(state:MatcherState,reading:Observation,nowAbsoluteS:number,origin:number,currentId:string,curves:Record<string,PointCurve>,cfg=matchingConfig):{state:MatcherState;decision:MatchDecision}{
 const observe=(reason:string,s=state,scores:CandidateScore[]=[]):{state:MatcherState;decision:MatchDecision}=>({state:s,decision:{kind:'OBSERVE',reason,scores,eventAbsoluteS:s.eventAbsoluteS}});
 if((reading.sceneMode??'windowed')!==(cfg.sceneMode??'windowed')||(curves[currentId]?.sceneMode??'windowed')!==(cfg.sceneMode??'windowed'))return observe('观测或当前工况来自其他场景，拒绝');
 if(!Number.isFinite(reading.valueC)||reading.valueC< -50||reading.valueC>2000||reading.monitorId!==cfg.monitorId||reading.absoluteS>nowAbsoluteS||reading.absoluteS<origin||reading.absoluteS<=state.lastAbsoluteS)return observe('无效、错点、未来或非单调观测，拒绝');
 let s:MatcherState={...state,history:[...state.history,reading].filter(x=>x.absoluteS>=reading.absoluteS-cfg.windowS),lastAbsoluteS:reading.absoluteS};
 const previous=state.history[state.history.length-1],raw=pointTemperature(curves[currentId],reading.absoluteS-origin);if(raw===null)return observe('当前同点数据缺失',s);
 if(previous&&reading.absoluteS-previous.absoluteS>cfg.maxGapS){s={...s,history:[reading],eventAbsoluteS:null,candidateId:null,confirmSinceS:null};return observe('观测间断或跳转，不当作温度突变',s);}
 // Capture a startup offset once; never continuously adapt it to hide later anomalies.
 const first=state.history[0];
 const firstRaw=first?pointTemperature(curves[currentId],first.absoluteS-origin):null;
 const baseline=state.residualBaselineC??cfg.initialResidualBiasC??(first&&firstRaw!==null?first.valueC-firstRaw:reading.valueC-raw);
 s={...s,residualBaselineC:baseline};
 const residual=reading.valueC-raw-baseline;
 const previousRaw=previous?pointTemperature(curves[currentId],previous.absoluteS-origin):null;
 const recent=s.history.filter(x=>x.absoluteS>=s.lastSwitchAbsoluteS).slice(-(cfg.persistentSamples??5));
 const residuals=recent.map(x=>{const predicted=pointTemperature(curves[currentId],x.absoluteS-origin);return predicted===null?null:x.valueC-predicted-baseline;});
 const sameDirection=residuals.filter(x=>x!==null&&Math.abs(x)>=cfg.deviationC&&Math.sign(x)===Math.sign(residual));
 const persistent=recent.length>=(cfg.persistentSamples??5)&&sameDirection.length>=(cfg.persistentRequired??4);
 const jump=previous&&previousRaw!==null&&Math.abs((reading.valueC-raw)-(previous.valueC-previousRaw))>=cfg.jumpC;
 if(s.eventAbsoluteS===null&&Math.abs(residual)>=cfg.deviationC&&(persistent||jump))s.eventAbsoluteS=reading.absoluteS;
 if(s.eventAbsoluteS===null)return observe('偏差未满足持续或突变条件',s);
 if(Math.abs(residual)<cfg.deviationC){s={...s,eventAbsoluteS:null,candidateId:null,confirmSinceS:null};return observe('偏差恢复，单次异常不切换',s);}
 if(reading.absoluteS-s.lastSwitchAbsoluteS<cfg.cooldownS)return observe('切换冷却期',s);
 const history=s.history.filter(x=>x.absoluteS>=s.eventAbsoluteS!);if(history.length<cfg.minSamples||history[history.length-1].absoluteS-history[0].absoluteS<cfg.confirmS)return observe('持续确认中',s);
 const scores=scoreCandidates(history.map(x=>({...x,valueC:x.valueC-baseline})),curves,origin,currentId,cfg),current=scores.find(x=>x.id===currentId),eligible=scores.filter(x=>x.allowed&&x.id!==currentId),best=eligible[0],runner=eligible[1];
 let reason='没有可靠同柜候选';
 if(best&&current){const improve=current.score-best.score;
  if(best.maeC>cfg.maxMaeC||best.currentErrorC>cfg.maxMaeC)reason='候选绝对误差过大';
  else if(improve<cfg.minImprovementC||improve/Math.max(current.score,.001)<cfg.minRelativeImprovement)reason='改善不足';
  else if(runner&&runner.score-best.score<cfg.marginC)reason='候选分数接近，继续观察';
  else {const since=s.candidateId===best.id?s.confirmSinceS??reading.absoluteS:reading.absoluteS;s={...s,candidateId:best.id,confirmSinceS:since};if(reading.absoluteS-since<cfg.confirmS)return observe('候选连续确认中',s,scores);
   const event=s.eventAbsoluteS;s={...s,eventAbsoluteS:null,candidateId:null,confirmSinceS:null,lastSwitchAbsoluteS:reading.absoluteS,residualBaselineC:reading.valueC-pointTemperature(curves[best.id],reading.absoluteS-origin)!};return {state:s,decision:{kind:'SWITCH',candidateId:best.id,reason:'同点同时刻历史误差、趋势、改善与迟滞门槛通过',scores,eventAbsoluteS:event}};}
 }
 s={...s,candidateId:null,confirmSinceS:null};return {state:s,decision:{kind:'UNMATCHED',reason,scores,eventAbsoluteS:s.eventAbsoluteS}};
}
