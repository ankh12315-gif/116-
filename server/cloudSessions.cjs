// Hosting adapter only: algorithms remain in Simulation; local API keeps its Map.
const {Simulation}=require('./simulation.cjs');
const omitted=new Set(['curves','cabinetCurves','cabinets','log']);
function encode(sessions){
 return JSON.stringify([...sessions].map(([id,s])=>[id,{updated:s.updated,state:Object.fromEntries(Object.entries(s.simulation).filter(([k])=>!omitted.has(k)))}]),(_k,v)=>typeof v==='number'&&!Number.isFinite(v)?{$number:String(v)}:v);
}
function decode(text,data){
 const rows=JSON.parse(text||'[]',(_k,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&Object.hasOwn(v,'$number')?Number(v.$number):v);
 return new Map(rows.map(([id,s])=>{const simulation=new Simulation({...data,config:s.state.config,demoSettings:s.state.demoSettings});Object.assign(simulation,s.state);return[id,{updated:s.updated,simulation}];}));
}
function redisStore(env=process.env,request=fetch){
 const url=env.UPSTASH_REDIS_REST_URL||env.KV_REST_API_URL,token=env.UPSTASH_REDIS_REST_TOKEN||env.KV_REST_API_TOKEN;
 if(!url||!token)throw Error('Cloud session storage is not configured');
 const command=async args=>{const r=await request(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Cloud session storage unavailable');const data=await r.json();if(data.error)throw Error('Cloud session storage command failed');return data.result;};
 const prefix='fire116:v1:'+(env.VERCEL_PROJECT_ID||'visualization');
 return {async acquire(){const owner=require('node:crypto').randomUUID();if(await command(['SET',prefix+':lock',owner,'NX','PX',65000])!=='OK')throw Error('Session service busy, please retry');return owner;},load:()=>command(['GET',prefix+':sessions']),save:text=>command(['SET',prefix+':sessions',text,'EX',3600]),release:owner=>command(['EVAL',"if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",'1',prefix+':lock',owner])};
}
module.exports={encode,decode,redisStore};
