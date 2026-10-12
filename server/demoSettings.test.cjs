const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {Simulation}=require('./simulation.cjs');
const {defaultSettings,validateSettings}=require('./demoSettings.cjs');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const data={beam:read('public/assets/monitor-v3/beam-curves.json'),cabinetCurves:read('public/assets/sensors-v11/cabinet-curves.json'),cabinets:read('public/assets/scenarios/cabinets.json').cabinets};
test('all sixteen configured scenarios start at second 11 and never at second 10',()=>{
 for(const id of Object.keys(data.beam)){
  const cabinet=id.split('-').slice(0,2).join('-'),power=id.includes('MW')?Number(id.split('-').at(-1).replace('MW','')):70;
  const draft=defaultSettings(data.cabinets);draft.temperaturesC[cabinet]=130;if(cabinet.startsWith('HV'))draft.powerMWByCabinet[cabinet]=power;
  const demoSettings=validateSettings(draft,data.cabinets,120,data.beam),s=new Simulation({...data,demoSettings,config:{triggerAtS:10}});
  assert.equal(s.initialId,id);s.step({absoluteS:9.9});assert.equal(s.phase,'MONITORING');assert.ok(s.snapshot().cabinetSensors.every(c=>c.valueC<120));
  s.step({absoluteS:10});assert.equal(s.phase,'MONITORING');assert.equal(s.snapshot().cabinetSensors.find(c=>c.id===cabinet).valueC,130);
  s.step({absoluteS:11});assert.equal(s.phase,'FIRE');assert.equal(s.activeId,id);assert.equal(s.origin,11);assert.equal(s.snapshot().displayFdsS,0);
  s.step({absoluteS:21,actualS:10,playing:true});assert.equal(s.snapshot().beam.deltaC,0);s.prepareInjection();
  if(s.snapshot().anomalyAvailable){s.inject();for(let t=11;t<=50&&!s.pending;t++)s.step({absoluteS:11+t,actualS:t,playing:true});assert.equal(s.pending?.kind,'STAGE');assert.equal(s.pending?.scenarioId,id);s.acknowledge(s.pending.token,true);assert.equal(s.activeId,id);assert.equal(s.snapshot().beam.deltaC,0);}
 }
});
test('no configured hot cabinet stays monitoring indefinitely and the old forced HV01 trigger is disabled',()=>{
 const s=new Simulation({...data,demoSettings:defaultSettings(data.cabinets),config:{triggerAtS:10}});
 for(const t of [0,10,11,30,60,1800]){s.step({absoluteS:t});assert.equal(s.phase,'MONITORING');assert.equal(s.origin,null);assert.equal(s.snapshot().mockInjected,false);}
});
test('configuration validation rejects multiple fires, missing values, invalid powers and nonnumeric readings',()=>{
 const base=defaultSettings(data.cabinets);
 assert.deepEqual(validateSettings(base,data.cabinets,120,data.beam),base);
 const hot=structuredClone(base);hot.temperaturesC['HV-01']=130;hot.temperaturesC['LV-03']=140;assert.throws(()=>validateSettings(hot,data.cabinets,120,data.beam),/一个起火柜体/);
 for(const value of [NaN,Infinity,'130',null,-51,2001]){const d=structuredClone(base);d.temperaturesC['HV-01']=value;assert.throws(()=>validateSettings(d,data.cabinets,120,data.beam));}
 const missing=structuredClone(base);delete missing.temperaturesC['LV-07'];assert.throws(()=>validateSettings(missing,data.cabinets,120,data.beam));
 const power=structuredClone(base);power.powerMWByCabinet['HV-02']=75;assert.throws(()=>validateSettings(power,data.cabinets,120,data.beam));
});
