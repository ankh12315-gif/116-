const {test,after}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const api=require('./api.cjs').createApi(path.resolve('public'));
const server=http.createServer(async(req,res)=>{if(!await api(req,res))res.writeHead(404).end();});
const ready=new Promise(r=>server.listen(0,'127.0.0.1',r));
after(()=>new Promise(r=>server.close(r)));
const testSettings=require('./demoSettings.cjs').defaultSettings(JSON.parse(require('node:fs').readFileSync('public/assets/scenarios/cabinets.json')).cabinets);testSettings.temperaturesC['HV-01']=130;
async function call(route,body,headers={}){if(route==='session'&&body&&!Object.hasOwn(body,'settings'))body={...body,settings:testSettings};await ready;return fetch('http://127.0.0.1:'+server.address().port+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});}

test('same-origin HTTPS requests work behind the deployment TLS proxy',async()=>{
 await ready;const Origin='https://127.0.0.1:'+server.address().port;
 const response=await call('session',{}, {Origin});assert.equal(response.status,200);
 const session=await response.json();assert.equal((await call('end',{session:session.id},{Origin})).status,200);
 assert.equal((await call('session',{}, {Origin:'https://other-host.example'})).status,403);
});

test('API step advertises prevalidated stage; injection instantly returns the beam marker and exact notice',async()=>{
 const s=await(await call('session',{})).json();assert.equal(s.anomalyAvailable,false);
 await call('step',{session:s.id,absoluteS:10});await call('step',{session:s.id,absoluteS:11});
 const checked=await(await call('step',{session:s.id,absoluteS:21,actualS:10,playing:true})).json();assert.equal(checked.anomalyAvailable,true);assert.equal(checked.anomalyAtS,10);
 const injected=await(await call('anomaly',{session:s.id})).json();assert.equal(injected.mockInjected,true);assert.equal(injected.anomalyAvailable,false);assert.deepEqual(injected.beam.position,[11.5,-12,4.5]);
 assert.equal(injected.notice,`梁下传感器温度与预测值偏差 +${injected.deltaC.toFixed(1)}℃`);assert.equal(injected.scenarioId,'HV-01-70MW');
});
test('API independent sessions, ten sensors, boot ignition and normal zero bias',async()=>{const a=await(await call('session',{})).json(),b=await(await call('session',{})).json();assert.notEqual(a.id,b.id);assert.equal(a.cabinetSensors.length,10);assert.equal((await(await call('step',{session:a.id,absoluteS:9})).json()).phase,'MONITORING');await call('step',{session:a.id,absoluteS:10});const r=await(await call('step',{session:a.id,absoluteS:11})).json();assert.equal(r.phase,'FIRE');assert.equal(r.origin,11);assert.equal(r.displayFdsS,0);const current=await(await call('step',{session:a.id,absoluteS:21,actualS:10,playing:true})).json();assert.equal(current.beam.deltaC,0);assert.equal((await(await call('state?session='+b.id)).json()).phase,'MONITORING');const injected=await(await call('anomaly',{session:a.id})).json();assert.ok(injected.deltaC>=12);assert.equal((await call('anomaly',{session:a.id})).status,400);});
test('API rejects foreign origins, oversized payloads, invalid readings, sessions and stale clocks',async()=>{assert.equal((await call('session',{}, {Origin:'https://foreign.example'})).status,403);assert.equal((await call('session',{data:'x'.repeat(33000)})).status,413);assert.equal((await call('state?session=missing')).status,404);const s=await(await call('session',{})).json();assert.equal((await call('readings',{session:s.id,id:'unknown',valueC:50,absoluteS:0,capturedAt:new Date().toISOString()})).status,400);await call('step',{session:s.id,absoluteS:1});assert.equal((await call('step',{session:s.id,absoluteS:0})).status,400);});
test('configured 10s MOCK wait never delays an earlier valid sensor alarm',async()=>{
 const s=await(await call('session',{})).json();await call('step',{session:s.id,absoluteS:1});
 assert.equal((await call('readings',{session:s.id,id:'LV-03',valueC:130,absoluteS:1,capturedAt:new Date().toISOString()})).status,200);
 await call('step',{session:s.id,absoluteS:1});const r=await(await call('step',{session:s.id,absoluteS:2})).json();
 assert.equal(r.phase,'FIRE');assert.equal(r.cabinetId,'LV-03');assert.equal(r.origin,2);assert.equal(r.displayFdsS,0);
});
test('API validates settings, supports no-fire monitoring and releases old sessions',async()=>{
 const options=await(await call('setup')).json();assert.equal(options.cabinetIds.length,10);assert.equal(options.triggerAtS,10);
 const draft=structuredClone(options.settings);draft.temperaturesC['HV-01']=130;draft.temperaturesC['HV-02']=130;
 assert.equal((await call('session',{settings:draft})).status,400);
 const neutral=await(await call('session',{settings:options.settings})).json();const state=await(await call('step',{session:neutral.id,absoluteS:30})).json();assert.equal(state.phase,'MONITORING');
 assert.equal((await call('end',{session:neutral.id})).status,200);assert.equal((await call('state?session='+neutral.id)).status,404);
 const d=structuredClone(options.settings);d.temperaturesC['HV-02']=130;d.powerMWByCabinet['HV-02']=140;
 const s=await(await call('session',{settings:d})).json();await call('step',{session:s.id,absoluteS:10});const r=await(await call('step',{session:s.id,absoluteS:11})).json();assert.equal(r.scenarioId,'HV-02-140MW');assert.equal(r.mockInjected,false);assert.equal(r.offsetS,0);
});


