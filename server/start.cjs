const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {createApi}=require('./api.cjs');
const root=path.resolve(__dirname,'../dist'),api=createApi(path.resolve(__dirname,'../public'),path.resolve(__dirname,'../docs/v11/runtime-events'));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.bin':'application/octet-stream','.f32':'application/octet-stream','.s3d':'application/octet-stream'};
http.createServer(async(req,res)=>{
 if(await api(req,res))return;
 let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));}catch{res.writeHead(400).end();return;}
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 let stat;try{stat=fs.statSync(file);}catch{res.writeHead(404).end();return;}if(!stat.isFile()){res.writeHead(404).end();return;}
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT)||5184,process.env.HOST||'127.0.0.1',()=>console.log('http://'+(process.env.HOST||'127.0.0.1')+':'+(process.env.PORT||5184)));
