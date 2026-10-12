const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{Readable}=require('node:stream');
const {encode,decode,redisStore}=require('./cloudSessions.cjs'),{Simulation}=require('./simulation.cjs'),{createHandler}=require('./vercelHandler.cjs');
const read=p=>JSON.parse(fs.readFileSync('public/'+p));
const data={beam:read('assets/monitor-v3/beam-curves.json'),cabinetCurves:read('assets/sensors-v11/cabinet-curves.json'),cabinets:read('assets/scenarios/cabinets.json').cabinets,config:JSON.parse(fs.readFileSync('server/fire-config.json'))};
test('hosting serialization preserves infinities and algorithm state without copying FDS curves',()=>{
 const s=new Simulation(data),map=new Map([['a',{updated:Date.now(),simulation:s}]]),text=encode(map),restored=decode(text,data).get('a').simulation;
 assert.equal(restored.lastActualS,-Infinity);assert.equal(restored.curves,data.beam);assert.ok(text.length<5000);assert.deepEqual(restored.snapshot(),s.snapshot());
});
test('separate cloud invocations preserve ignition, exact bias, match, acknowledgement and end',async()=>{
 let saved=null,locked=false;
 const storage={async acquire(){assert.equal(locked,false);locked=true;return 'owner';},async load(){return saved;},async save(v){saved=v;},async release(){locked=false;}};
 const call=async(route,body)=>{
  // New handler on every call models a fresh cloud instance.
  const handler=createHandler(()=>storage),req=Readable.from([]);req.headers={host:'test.example',origin:'https://test.example'};req.method=body===undefined?'GET':'POST';req.url='/api/index?endpoint='+route; if(body!==undefined)req.body=body;
  let code,result;await handler(req,{writeHead(status){code=status;return this;},end(v){result=JSON.parse(v);}});assert.equal(code,200,JSON.stringify(result));return result;
 };
 const setup=await call('setup');setup.settings.temperaturesC['HV-01']=130;
 const s=await call('session',{settings:setup.settings}),id=s.id;
 assert.equal((await call('step',{session:id,absoluteS:9})).phase,'MONITORING');
 await call('step',{session:id,absoluteS:10});assert.equal((await call('step',{session:id,absoluteS:11})).origin,11);
 const checked=await call('step',{session:id,absoluteS:21,actualS:10,playing:true});assert.equal(checked.beam.deltaC,0);assert.equal(checked.anomalyAvailable,true);
 const injected=await call('anomaly',{session:id});assert.ok(injected.injectedDeltaC>=12);
 let pending;
 for(let t=11;t<=50;t++){const r=await call('step',{session:id,absoluteS:11+t,actualS:t,playing:true});if(r.pending){pending=r.pending;break;}}
 assert.equal(pending?.scenarioId,'HV-01-70MW');
 const applied=await call('ack',{session:id,token:pending.token,success:true});assert.equal(applied.offsetS,pending.offsetS);
 await call('end',{session:id});assert.equal(decode(saved,data).size,0);
});
test('missing cloud credentials fail closed; lock commands have bounded expiry and owner release',async()=>{
 assert.throws(()=>redisStore({}),/not configured/);
 const calls=[],store=redisStore({UPSTASH_REDIS_REST_URL:'https://redis.example',UPSTASH_REDIS_REST_TOKEN:'test-only'},async(_url,options)=>{calls.push(JSON.parse(options.body));return{ok:true,json:async()=>({result:'OK'})};});
 const owner=await store.acquire();await store.release(owner);assert.deepEqual(calls[0].slice(-3),['NX','PX',65000]);assert.equal(calls[1][0],'EVAL');assert.equal(calls[1].at(-1),owner);
});
test('overlapping cloud sampling and button requests wait briefly instead of losing state',async()=>{
 let tries=0;
 const store=redisStore({KV_REST_API_URL:'https://redis.example',KV_REST_API_TOKEN:'test-only'},async()=>({ok:true,json:async()=>({result:++tries===1?null:'OK'})}));
 assert.equal(typeof await store.acquire(),'string');assert.equal(tries,2);
});
