const path=require('node:path'),fs=require('node:fs'),{Readable}=require('node:stream');
const {createApi}=require('./api.cjs'),{encode,decode,redisStore}=require('./cloudSessions.cjs');
const root=path.resolve(__dirname,'../public');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const data={beam:read('assets/monitor-v3/beam-curves.json'),cabinetCurves:read('assets/sensors-v11/cabinet-curves.json'),cabinets:read('assets/scenarios/cabinets.json').cabinets};
function createHandler(storeFactory=()=>redisStore()){
 return async(req,res)=>{
  const url=new URL(req.url,'https://'+req.headers.host),endpoint=url.searchParams.get('endpoint');
  if(endpoint!==null){url.pathname='/api/'+endpoint;url.searchParams.delete('endpoint');}
  const input=req.body!==undefined?Readable.from([typeof req.body==='string'?req.body:JSON.stringify(req.body)]):req;
  input.url=url.pathname+url.search;input.headers=req.headers;input.method=req.method;
  if(url.pathname==='/api/setup'&&req.method==='GET')return createApi(root,null)(input,res);
  let store,owner;
  try{
   store=storeFactory();owner=await store.acquire();const sessions=decode(await store.load(),data);
   let status=200,headers={},body;
   const output={writeHead(s,h){status=s;headers=h;return this;},end(value){body=value;}};
   const handled=await createApi(root,null,{sessions})(input,output);
   if(!handled){status=404;headers={'Content-Type':'application/json'};body=JSON.stringify({error:'Endpoint not found'});}
   await store.save(encode(sessions));await store.release(owner);owner=null;
   res.writeHead(status,headers);res.end(body);
  }catch{res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':'1'});res.end(JSON.stringify({error:'会话服务暂不可用，请稍后重试'}));}
  finally{if(owner)try{await store.release(owner);}catch{}}
 };
}
module.exports={createHandler};
