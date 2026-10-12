const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Simulation}=require('./simulation.cjs');
const {POWERS,defaultSettings,validateSettings}=require('./demoSettings.cjs');
function createApi(publicRoot,logDir,options={}){
 const read=p=>JSON.parse(fs.readFileSync(path.join(publicRoot,p),'utf8'));
 const data={beam:read('assets/monitor-v3/beam-curves.json'),cabinetCurves:read('assets/sensors-v11/cabinet-curves.json'),cabinets:read('assets/scenarios/cabinets.json').cabinets,config:JSON.parse(fs.readFileSync(path.join(__dirname,'fire-config.json'),'utf8'))};
 const sessions=options.sessions??new Map();
 return async function api(req,res){
  if(!req.url?.startsWith('/api/'))return false;
  const send=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
  try{
   if(req.method!=='GET'&&req.method!=='POST'){send(405,{error:'Method'});return true;}
   // The hosting proxy terminates HTTPS before forwarding to this Node service.
   if(req.headers.origin&&!['http','https'].some(protocol=>req.headers.origin===`${protocol}://${req.headers.host}`)){send(403,{error:'Origin'});return true;}
   let body={};if(req.method==='POST'){
    let bytes=0,text='';for await(const chunk of req){bytes+=chunk.length;if(bytes>32768){send(413,{error:'Body too large'});return true;}text+=chunk;}
    body=JSON.parse(text||'{}');
   }
   const url=new URL(req.url,`http://${req.headers.host}`);
   if(url.pathname==='/api/setup'&&req.method==='GET'){send(200,{settings:defaultSettings(data.cabinets),cabinetIds:data.cabinets.map(c=>c.id),powers:POWERS,triggerAtS:data.config.triggerAtS,thresholdC:data.config.thresholdC,holdS:data.config.holdS});return true;}
   for(const [id,s]of sessions)if(Date.now()-s.updated>3600000)sessions.delete(id);
   if(url.pathname==='/api/session'&&req.method==='POST'){
    if(sessions.size>=20){send(429,{error:'Session limit'});return true;}
    const demoSettings=validateSettings(body.settings??defaultSettings(data.cabinets),data.cabinets,data.config.thresholdC,data.beam);
    const id=crypto.randomUUID();const simulation=new Simulation({...data,demoSettings,log:e=>{if(logDir){fs.mkdirSync(logDir,{recursive:true});fs.appendFileSync(path.join(logDir,id+'.ndjson'),JSON.stringify(e)+'\n');}}});
    sessions.set(id,{simulation,updated:Date.now()});send(200,{id,...simulation.snapshot()});return true;
   }
   const id=url.searchParams.get('session')||body.session;const session=sessions.get(id);if(!session){send(404,{error:'传感器会话不存在，请刷新可视化页面'});return true;}session.updated=Date.now();
   const s=session.simulation;
   if(url.pathname==='/api/end'&&req.method==='POST'){sessions.delete(id);send(200,{ended:true});}
   else if(url.pathname==='/api/state'&&req.method==='GET')send(200,s.snapshot());
   else if(url.pathname==='/api/step'&&req.method==='POST'){s.step(body);s.prepareInjection();send(200,s.snapshot());}
   else if(url.pathname==='/api/anomaly'&&req.method==='POST'){const change=s.inject();send(200,{...s.snapshot(),...change});}
   else if(url.pathname==='/api/ack'&&req.method==='POST')send(200,s.acknowledge(body.token,body.success===true));
   else if(url.pathname==='/api/readings'&&req.method==='POST'){s.ingest(body);send(200,s.snapshot());}
   else send(404,{error:'Endpoint not found'});
  }catch(e){send(400,{error:e.message});}
  return true;
 };
}
module.exports={createApi};
