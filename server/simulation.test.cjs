const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {Simulation,temperature,match,scenario}=require('./simulation.cjs');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const data={beam:read('public/assets/monitor-v3/beam-curves.json'),cabinetCurves:read('public/assets/sensors-v11/cabinet-curves.json'),cabinets:read('public/assets/scenarios/cabinets.json').cabinets};
function started(config={}){const s=new Simulation({...data,config});s.step({absoluteS:5});s.step({absoluteS:6});return s;}
function run(s,from,to){for(let t=from;t<=to;t++)s.step({absoluteS:6+t,actualS:t,playing:true});}

test('Preflight is cached by current stage and unavailable for flat, paused or external sources',()=>{
 const s=started();run(s,0,10);s.prepareInjection();assert.equal(s.snapshot().anomalyAvailable,true);
 const plan=s.anomalyPlan;assert.equal(s.planInjection(),plan);assert.equal(s.snapshot().anomalyAtS,10);
 const expected=temperature(s.curves[s.activeId],10+plan.offsetS)-temperature(s.curves[s.activeId],10);
 const change=s.inject();assert.equal(change.deltaC,expected);assert.equal(s.anomalyPlan,plan);
 assert.equal(s.snapshot().anomalyAvailable,false);assert.deepEqual(s.snapshot().beam.position,[11.5,-12,4.5]);
 assert.equal(s.notice,`梁下传感器温度与预测值偏差 +${expected.toFixed(1)}℃`);
 assert.equal(s.snapshot().beam.deltaC,expected);
 const paused=started();run(paused,0,10);paused.step({absoluteS:16,actualS:10,playing:false});paused.prepareInjection();assert.equal(paused.snapshot().anomalyAvailable,false);assert.throws(()=>paused.inject());
 const external=started();run(external,0,10);external.ingest({id:'beam',valueC:40,absoluteS:16,capturedAt:new Date().toISOString()});external.prepareInjection();assert.equal(external.snapshot().anomalyAvailable,false);
 const flat={timesS:[0,1800],temperatureC:[20,20],sampledFdsM:[11.5,-12,4.5]};
 const unavailable=new Simulation({...data,beam:{'HV-01-70MW':flat}});unavailable.step({absoluteS:5});unavailable.step({absoluteS:6});run(unavailable,0,10);unavailable.prepareInjection();assert.equal(unavailable.snapshot().anomalyAvailable,false);
});

test('Every advertised real-curve preflight has a same-case match and time changes invalidate the cache',()=>{
 let available=0;
 for(const id of Object.keys(data.beam)){
  const cabinetId=id.split('-').slice(0,2).join('-'),powerMW=id.includes('MW')?Number(id.split('-').at(-1).replace('MW','')):70;
  const s=started({cabinetId,powerMW});run(s,0,10);s.prepareInjection();
  if(!s.snapshot().anomalyAvailable)continue;
  available++;const plan=s.anomalyPlan;s.inject();run(s,11,50);
  assert.equal(s.pending?.kind,'STAGE',id);assert.equal(s.pending.scenarioId,id);assert.ok(Math.abs(s.pending.offsetS-plan.offsetS)<=2,id);
 }
 assert.ok(available>0);
 const s=started();run(s,0,10);s.prepareInjection();const old=s.planKey;run(s,11,11);s.prepareInjection();assert.notEqual(s.planKey,old);assert.equal(s.snapshot().anomalyAtS,s.anomalyPlan?11:null);
});
test('All ten cabinets have independent channels and auto ignition selects each correct case',()=>{for(const c of data.cabinets){const s=started({cabinetId:c.id});assert.equal(s.snapshot().cabinetSensors.length,10);assert.equal(s.phase,'FIRE');assert.equal(s.activeId,scenario(c.id,70));assert.equal(s.events.filter(e=>e.type==='IGNITION').length,1);}});
test('Threshold requires hold, recovery resets, power is not temperature',()=>{const s=new Simulation({...data,config:{triggerAtS:999}});s.step({absoluteS:0});s.ingest({id:'LV-03',valueC:130,absoluteS:0,capturedAt:new Date().toISOString()});s.step({absoluteS:.5});assert.equal(s.phase,'MONITORING');s.ingest({id:'LV-03',valueC:20,absoluteS:.5,capturedAt:new Date().toISOString()});s.step({absoluteS:1});s.ingest({id:'LV-03',valueC:130,absoluteS:1,capturedAt:new Date().toISOString()});s.step({absoluteS:1});s.step({absoluteS:2});assert.equal(s.activeId,'LV-03-FIRE');assert.equal(s.origin,2);});
test('Normal MOCK equals FDS, zero correction and no scheduled 30s switch',()=>{const s=started();run(s,0,180);const snap=s.snapshot();assert.equal(snap.beam.valueC,snap.beam.rawFdsC);assert.equal(snap.beam.deltaC,0);assert.equal(snap.beam.correctedC,snap.beam.rawFdsC);assert.equal(s.activeId,'HV-01-70MW');assert.equal(s.offsetS,0);assert.equal(s.events.filter(x=>x.type==='MATCH_PROPOSED').length,0);});
test('Real curves button injects known-findable stage; actual clock unchanged, commit only after renderer ack',()=>{const s=started();run(s,0,10);const change=s.inject();assert.ok(change.deltaC>=12&&change.deltaC<=180);run(s,11,50);assert.equal(s.pending.kind,'STAGE');assert.equal(s.activeId,'HV-01-70MW');assert.equal(s.offsetS,0);const actual=s.actualS,origin=s.origin,offset=s.pending.offsetS;s.acknowledge(s.pending.token,true);assert.equal(s.origin,origin);assert.equal(s.actualS,actual);assert.equal(s.snapshot().displayFdsS,actual+offset);assert.equal(s.snapshot().beam.deltaC,0);run(s,51,100);assert.equal(s.events.filter(x=>x.type==='MATCH_APPLIED').length,1);});
test('Missing and ambiguous stage never force a switch',()=>{const flat={timesS:[0,1800],temperatureC:[20,20],sampledFdsM:[11.5,-12,4.5]};const lib={'HV-01-70MW':flat};const s=new Simulation({...data,beam:lib});s.step({absoluteS:5});s.step({absoluteS:6});run(s,0,10);assert.throws(()=>s.inject());assert.equal(match(Array.from({length:8},(_,i)=>({actualS:i,valueC:80})),s.activeId,0,lib).kind,'UNMATCHED');});
test('Matching never falls back to another power even when it matches exactly',()=>{const curve=v=>({timesS:[0,1800],temperatureC:[v,v],sampledFdsM:[11.5,-12,4.5]});const lib={'HV-01-70MW':curve(20),'HV-01-140MW':curve(90),'HV-02-100MW':curve(90),'HV-01-100MW':{...curve(90),sampledFdsM:[0,0,0]}};const h=Array.from({length:8},(_,i)=>({actualS:i,valueC:90}));const r=match(h,'HV-01-70MW',0,lib);assert.equal(r.kind,'UNMATCHED');assert.equal(r.scenarioId,undefined);});
test('One-sample spike, paused steps and backward time do not cause matching',()=>{const s=started();run(s,0,10);s.external.beam={valueC:500,absoluteS:17};s.step({absoluteS:17,actualS:11,playing:true});delete s.external.beam;run(s,12,30);assert.equal(s.pending,null);s.step({absoluteS:36,actualS:30,playing:false});assert.deepEqual(s.history,[]);assert.throws(()=>s.step({absoluteS:35,actualS:29,playing:true}));});
test('Stale external readings unavailable; NaN, future, unknown and repeated readings rejected',()=>{const s=started();run(s,0,10);for(const patch of [{id:'bad'},{valueC:NaN},{absoluteS:999},{capturedAt:'bad'}])assert.throws(()=>s.ingest({id:'beam',valueC:90,absoluteS:16,capturedAt:new Date().toISOString(),...patch}));s.ingest({id:'beam',valueC:90,absoluteS:16,capturedAt:new Date().toISOString()});assert.throws(()=>s.ingest({id:'beam',valueC:90,absoluteS:16,capturedAt:new Date().toISOString()}));run(s,11,20);assert.equal(s.snapshot().beam.valueC,null);assert.equal(s.pending,null);});
test('Failed or stale renderer ack preserves original dataset and stage',()=>{const s=started();run(s,0,10);s.inject();run(s,11,50);assert.throws(()=>s.acknowledge('wrong',true));s.acknowledge(s.pending.token,false);assert.equal(s.offsetS,0);assert.equal(s.activeId,'HV-01-70MW');});
test('Independent sessions do not share injection or events',()=>{const a=started(),b=started();run(a,0,10);run(b,0,10);a.inject();assert.equal(b.injection,null);assert.equal(b.events.length,1);});
test('Unavailable FDS time returns null and raw curves stay unchanged',()=>{const before=JSON.stringify(data.beam);const s=started();run(s,0,10);s.inject();run(s,11,30);assert.equal(JSON.stringify(data.beam),before);assert.equal(temperature(data.beam['HV-01-70MW'],1801),null);});
test('External freshness expires on wall clock even while replay is paused; own sample time is used',()=>{const s=started();s.step({absoluteS:16.5,actualS:10.5,playing:true});const value=temperature(data.beam[s.activeId],10.5);s.ingest({id:'beam',valueC:value,absoluteS:16.5,capturedAt:new Date().toISOString()});assert.equal(s.snapshot().beam.deltaC,0);assert.equal(s.snapshot().beam.sampleActualS,10.5);s.external.beam.receivedAtMs-=3000;s.step({absoluteS:16.5,actualS:10.5,playing:false});assert.equal(s.snapshot().beam.valueC,null);assert.throws(()=>s.ingest({id:'beam',valueC:90,absoluteS:16.5,capturedAt:'2020-01-01T00:00:00Z'}));});

