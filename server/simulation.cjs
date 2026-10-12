// Independent sensor source and classifier. No rendering or FDS file mutation.
const defaults={cabinetId:'HV-01',powerMW:70,triggerAtS:5,triggerTemperatureC:130,thresholdC:120,holdS:1,phaseSearchMaxS:120,anomalyC:8,confirmSamples:6,maxMaeC:3,point:[11.5,-12,4.5]};
function temperature(curve,t){
 if(!curve||!Number.isFinite(t)||t<curve.timesS[0]||t>curve.timesS.at(-1))return null;
 let lo=0,hi=curve.timesS.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(curve.timesS[mid]<=t)lo=mid;else hi=mid;}
 const span=curve.timesS[hi]-curve.timesS[lo];return span?curve.temperatureC[lo]+(curve.temperatureC[hi]-curve.temperatureC[lo])*(t-curve.timesS[lo])/span:curve.temperatureC[lo];
}
function scenario(id,power){if(/^HV-0[12]$/.test(id)&&[40,70,100,140].includes(power))return `${id}-${power}MW`;if(/^LV-0[1-8]$/.test(id))return `${id}-FIRE`;throw Error('Invalid cabinet/power');}
function samePoint(a,b){return !!a&&!!b&&(a.sceneMode??'windowed')==='windowed'&&(b.sceneMode??'windowed')==='windowed'&&a.sampledFdsM?.length===3&&b.sampledFdsM?.length===3&&a.sampledFdsM.every((v,i)=>Math.abs(v-b.sampledFdsM[i])<1e-6)&&a.openingAtS===b.openingAtS;}
function fresh(reading,absoluteS){return absoluteS-reading.absoluteS<=2&&Date.now()-(reading.receivedAtMs??Date.now())<=2000;}
function score(history,curve,offset){
 const p=history.map(x=>temperature(curve,x.actualS+offset));if(p.some(v=>v===null)||!history.length)return null;
 const errs=p.map((v,i)=>v-history[i].valueC),mae=errs.reduce((s,e)=>s+Math.abs(e),0)/errs.length,dt=history.at(-1).actualS-history[0].actualS;
 const slope=dt>0?Math.abs((p.at(-1)-p[0]-(history.at(-1).valueC-history[0].valueC))/dt):0;
 return {mae,currentError:Math.abs(errs.at(-1)),slope,score:mae+.5*slope};
}
function match(history,currentId,currentOffset,curves,cfg=defaults){
 const current=curves[currentId],baseline=score(history,current,currentOffset);if(!baseline)return {kind:'UNMATCHED',reason:'同点数据缺失'};
 const valid=(x)=>x&&x.mae<=cfg.maxMaeC&&x.currentError<=cfg.maxMaeC&&x.slope<=1&&baseline.score-x.score>=6;
 const candidates=[];
 for(let offset=Math.ceil(currentOffset)+1;offset<=Math.floor(currentOffset+cfg.phaseSearchMaxS);offset++){
  const s=score(history,current,offset);if(s)candidates.push({...s,offset});
 }
 candidates.sort((a,b)=>a.score-b.score);const best=candidates[0];
 if(valid(best)){
  // Similar nearby shifts are a single stage band; distant equally good stages are ambiguous.
  const rival=candidates.find(x=>Math.abs(x.offset-best.offset)>5&&x.score-best.score<.5);
  if(!rival)return {kind:'STAGE',scenarioId:currentId,offsetS:best.offset,...best,reason:'同工况连续曲线与趋势匹配'};
  return {kind:'UNMATCHED',reason:'同工况存在多个相近阶段，继续观察'};
 }
 return {kind:'UNMATCHED',reason:'当前工况没有可信的后续阶段'};
}
class Simulation {
 constructor({beam,cabinetCurves,cabinets,config={},demoSettings=null,log=()=>{}}){
  this.curves=beam;this.cabinetCurves=cabinetCurves;this.cabinets=cabinets;this.config={...defaults,...config};
  this.demoSettings=demoSettings;
  if(demoSettings){const hot=cabinets.find(c=>demoSettings.temperaturesC[c.id]>=this.config.thresholdC);this.config.cabinetId=hot?.id??'HV-01';this.config.powerMW=demoSettings.powerMWByCabinet[this.config.cabinetId]??70;}
  this.initialId=scenario(this.config.cabinetId,this.config.powerMW);if(!beam[this.initialId])throw Error('Configured FDS curve unavailable');
  if(this.config.point.length!==3||this.config.point.some((x,i)=>Math.abs(x-beam[this.initialId].sampledFdsM[i])>1e-6))throw Error('Configured monitor differs from available FDS point');
  this.activeId=this.initialId;this.offsetS=0;this.phase='MONITORING';this.absoluteS=0;this.origin=null;this.actualS=0;this.lastActualS=-Infinity;this.above={};this.history=[];this.events=[];this.external={};this.log=log;this.notice='';this.pending=null;this.injection=null;
 }
 event(type,data){const e={type,absoluteS:this.absoluteS,actualS:this.actualS,displayFdsS:this.actualS+this.offsetS,...data};this.events.push(e);if(this.events.length>200)this.events.shift();this.log(e);}
 cabinetRows(t){return this.cabinets.map(c=>{
  const curve=this.cabinetCurves[this.activeId]?.[c.id];let value=temperature(curve,this.origin===null?0:t+this.offsetS);let source=curve?'MOCK_FDS':'MOCK_INITIAL';
  if(value===null){value=20;source='MOCK_INITIAL';}
  if(this.origin===null&&this.absoluteS>=this.config.triggerAtS){
   if(this.demoSettings){value=this.demoSettings.temperaturesC[c.id];source='MOCK_SETTING';}
   else if(c.id===this.config.cabinetId){value=this.config.triggerTemperatureC;source='MOCK_TRIGGER';}
  }
  const external=this.external[c.id];if(external){value=fresh(external,this.absoluteS)?external.valueC:null;source='SENSOR';}
  return {id:c.id,valueC:value,source,position:curve?.sampledFdsM??null,location:curve?'柜附近气相点（非核验柜内）':'无可信测点，MOCK初始值',alarm:value!==null&&value>=this.config.thresholdC};
 });}
 reading(t){
  const external=this.external.beam;if(external)return fresh(external,this.absoluteS)?{valueC:external.valueC,source:'SENSOR',sampleAbsoluteS:external.absoluteS,actualS:external.absoluteS-this.origin}:null;
  const valueC=temperature(this.curves[this.initialId],t+(this.injection?.offsetS??0));return valueC===null?null:{valueC,source:'MOCK',sampleAbsoluteS:this.origin+t,actualS:t};
 }
 planInjection(){
  const key=`${this.activeId}:${this.offsetS}:${this.actualS}`;
  if(this.planKey===key)return this.anomalyPlan;
  const curve=this.curves[this.initialId],t=this.actualS,base=temperature(curve,t),candidates=[];
  // Choose a reproducible increase backed by a distinguishable future segment, not arbitrary +100.
  for(let shift=5;shift<=this.config.phaseSearchMaxS;shift++){
   const target=temperature(curve,t+shift);if(base===null||target===null||target-base<12||target-base>180)continue;
   const fixture=Array.from({length:8},(_,i)=>({actualS:t+i,valueC:temperature(curve,t+i+shift)}));if(fixture.some(x=>x.valueC===null))continue;
   const found=match(fixture,this.activeId,this.offsetS,this.curves,this.config);
   if(found.kind==='STAGE'&&found.scenarioId===this.activeId&&Math.abs(found.offsetS-shift)<=2)candidates.push({offsetS:shift,deltaC:target-base,distance:Math.abs(target-base-50)});
  }
  candidates.sort((a,b)=>a.distance-b.distance);
  let best=null;
  for(const candidate of candidates){
   const shift=candidate.offsetS;
    // Offline MOCK fixture planning verifies the full detector, not just an isolated score.
    const probe=new Simulation({beam:this.curves,cabinetCurves:this.cabinetCurves,cabinets:this.cabinets,config:this.config});
    Object.assign(probe,{phase:'FIRE',origin:0,initialId:this.initialId,activeId:this.activeId,actualS:t,lastActualS:t,offsetS:this.offsetS,injection:{offsetS:shift}});
    for(let i=1;i<=40;i++){probe.step({absoluteS:t+i,actualS:t+i,playing:true});if(probe.pending)break;}
    if(probe.pending?.kind==='STAGE'&&probe.pending.scenarioId===this.activeId&&Math.abs(probe.pending.offsetS-shift)<=2){best={...candidate,atActualS:t};break;}
  }
  this.planKey=key;this.anomalyPlan=best;return best;
 }
 prepareInjection(){
  this.anomalyAvailable=!!(this.phase==='FIRE'&&this.playing&&!this.pending&&!this.injection&&!this.external.beam&&this.planInjection());
 }
 inject(){
  if(this.phase!=='FIRE'||!this.playing||this.pending||this.injection||this.external.beam)throw Error('仅在MOCK火灾正向播放中可注入一次异常');
  const best=this.planInjection();
  if(!best)throw Error('当前阶段暂无可匹配的升温结果');
  this.injection={offsetS:best.offsetS,atActualS:best.atActualS,deltaC:best.deltaC};this.anomalyAvailable=false;
  this.notice=`梁下传感器温度与预测值偏差 +${best.deltaC.toFixed(1)}℃`;this.event('MOCK_INJECTION',{deltaC:best.deltaC,sourceOffsetS:best.offsetS});return {deltaC:best.deltaC};
 }
 ingest({id,valueC,absoluteS,capturedAt}){
  if(!this.cabinets.some(c=>c.id===id)&&id!=='beam')throw Error('Unknown sensor');
  const timestamp=Date.parse(capturedAt),now=Date.now();
  if(!Number.isFinite(valueC)||valueC< -50||valueC>2000||!Number.isFinite(absoluteS)||absoluteS<0||absoluteS>this.absoluteS||absoluteS<=(this.external[id]?.absoluteS??-Infinity)||!Number.isFinite(timestamp)||now-timestamp>2000||timestamp-now>2000)throw Error('Invalid/stale/future sensor reading');
  this.external[id]={valueC,absoluteS,capturedAt,receivedAtMs:now};this.event('SENSOR_READING',{id,valueC,absoluteS,capturedAt});
 }
 step({absoluteS,actualS,playing=false}){
  if(!Number.isFinite(absoluteS)||absoluteS<0||absoluteS<this.absoluteS)throw Error('Non-monotonic sensor clock');
  this.absoluteS=absoluteS;
  this.playing=playing;
  if(this.phase==='MONITORING'){
   for(const row of this.cabinetRows(0)){
    if(row.valueC!==null&&row.valueC>=this.config.thresholdC){this.above[row.id]??=absoluteS;if(absoluteS-this.above[row.id]>=this.config.holdS){this.origin=absoluteS;this.activeId=scenario(row.id,this.demoSettings?.powerMWByCabinet[row.id]??this.config.powerMW);this.initialId=this.activeId;this.phase='FIRE';this.event('IGNITION',{cabinetId:row.id,scenarioId:this.activeId,thresholdMeaning:'DEMO_ONLY'});break;}}
    else delete this.above[row.id];
   }
   return this.snapshot();
  }
  if(!Number.isFinite(actualS)||actualS<0||actualS>1800)throw Error('Invalid actual fire time');
  if(!playing){this.history=[];this.confirm=null;return this.snapshot();}
  const sample=Math.floor(actualS);if(sample<=this.lastActualS)return this.snapshot();
  const gap=sample-this.lastActualS;this.actualS=sample;this.lastActualS=sample;
  if(gap>2.5){this.history=[];this.confirm=null;}
  const reading=this.reading(sample),raw=reading?temperature(this.curves[this.activeId],reading.actualS+this.offsetS):null;
  if(!reading||raw===null)return this.snapshot();
  if(reading.source==='SENSOR'&&reading.sampleAbsoluteS===this.lastExternalSample)return this.snapshot();
  if(reading.source==='SENSOR')this.lastExternalSample=reading.sampleAbsoluteS;
  this.history.push({actualS:reading.actualS,valueC:reading.valueC});this.history=this.history.filter(x=>x.actualS>=reading.actualS-8);
  if(this.pending||sample-(this.lastSwitch??-Infinity)<30)return this.snapshot();
  const residual=reading.valueC-raw;
  const recent=this.history.slice(-5);const persistent=recent.length===5&&recent.filter(x=>{const v=temperature(this.curves[this.activeId],x.actualS+this.offsetS);return v!==null&&Math.abs(x.valueC-v)>=this.config.anomalyC&&Math.sign(x.valueC-v)===Math.sign(residual);}).length>=4;
  if(!persistent||Math.abs(residual)<this.config.anomalyC){this.confirm=null;return this.snapshot();}
  const window=this.history.filter(x=>Math.abs(x.valueC-temperature(this.curves[this.activeId],x.actualS+this.offsetS))>=this.config.anomalyC);
  if(window.length<this.config.confirmSamples||window.at(-1).actualS-window[0].actualS<5)return this.snapshot();
  const result=match(window,this.activeId,this.offsetS,this.curves,this.config);
  if(result.kind==='UNMATCHED'){if(!this.injection)this.notice=result.reason;this.confirm=null;return this.snapshot();}
  const key=result.scenarioId+':'+result.offsetS;
  if(!this.confirm||this.confirm.key!==key){this.confirm={key,since:sample};return this.snapshot();}
  if(sample-this.confirm.since<3)return this.snapshot();
  this.pending={...result,token:require('node:crypto').randomUUID(),atActualS:sample};this.notice='正在加载匹配的FDS阶段';this.event('MATCH_PROPOSED',this.pending);return this.snapshot();
 }
 acknowledge(token,success){
  if(!this.pending||this.pending.token!==token)throw Error('Stale match acknowledgement');
  if(success){this.activeId=this.pending.scenarioId;this.offsetS=this.pending.offsetS;this.lastSwitch=this.actualS;this.notice=`已匹配FDS阶段：实际${this.actualS.toFixed(0)}秒 → FDS${(this.actualS+this.offsetS).toFixed(0)}秒`;this.event('MATCH_APPLIED',this.pending);}
  else{this.notice='FDS数据加载失败，保留原工况';this.event('MATCH_FAILED',this.pending);}
  this.pending=null;this.confirm=null;this.history=[];return this.snapshot();
 }
 snapshot(){
  const reading=this.origin===null?null:this.reading(this.actualS),raw=temperature(this.curves[this.activeId],(reading?.actualS??this.actualS)+this.offsetS),delta=reading&&raw!==null?reading.valueC-raw:null;
  return {phase:this.phase,absoluteS:this.absoluteS,origin:this.origin,actualS:this.actualS,displayFdsS:this.actualS+this.offsetS,offsetS:this.offsetS,scenarioId:this.activeId,cabinetId:this.activeId.split('-').slice(0,2).join('-'),cabinetSensors:this.cabinetRows(this.actualS),beam:{id:'beam',position:this.config.point,source:this.external.beam?'SENSOR':'MOCK',sampleActualS:reading?.actualS??null,sampleFdsS:reading?reading.actualS+this.offsetS:null,valueC:reading?.valueC??null,rawFdsC:raw,deltaC:delta,correctedC:raw!==null&&delta!==null?raw+Math.max(-20,Math.min(20,delta)):null},pending:this.pending,mockInjected:!!this.injection,injectedDeltaC:this.injection?.deltaC??null,anomalyAvailable:!!this.anomalyAvailable,anomalyAtS:this.anomalyPlan?.atActualS??null,notice:this.notice,events:this.events,config:this.config,clockMode:'MOCK_SIMULATION_CLOCK; real uploads include capturedAt'};
 }
}
module.exports={Simulation,temperature,match,score,scenario,defaults};

