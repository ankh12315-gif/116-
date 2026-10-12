"""只读源FDS/DEVC/SF；导出独立监测曲线，不触碰已有结果资产。"""
import csv, hashlib, json, math, re, struct
from pathlib import Path
from audit_delivery import raw_slice_frames
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/v3';OUT.mkdir(exist_ok=True)
CANDIDATES={'wall':(12.5,-10.5,3.0),'beam':(11.5,-12,4.5),'cabinet':(10.5,-13.5,1.5),'roof':(6.75,-7.75,6.0)}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 curves={};stats=[];inventory=[]
 for folder in sorted((ROOT/'public/assets/results').iterdir()):
  m=json.loads((folder/'manifest.json').read_text());pr=m['dataProvenance'];fds=next((ROOT/x['path'] for x in m['sourceFiles'] if x['path'].endswith('.fds')),ROOT/pr.get('sourceDirectory','')/(m['chid']+'.fds'))
  text=fds.read_text(encoding='utf8');dev=[]
  for block in re.findall(r'&DEVC\b.*?/',text,re.S):
   pos=re.search(r'XYZ\s*=\s*([\d.eE+,-]+)',block);name=re.search(r"ID\s*=\s*'([^']+)'",block)
   if pos and name:dev.append({'id':name[1],'xyz':list(map(float,pos[1].rstrip(',').split(',')))})
  csvp=next((ROOT/x['path'] for x in m['sourceFiles'] if x['path'].endswith('_devc.csv')),None)
  devc_summary=[]
  if csvp:
   with csvp.open(encoding='utf-8-sig') as f:
    rows=list(csv.reader(f));headers=rows[1];records=[[float(x) for x in row] for row in rows[2:] if row]
   for d in dev:
    if d['id'] not in headers:continue
    idx=headers.index(d['id']);vals=[row[idx] for row in records]
    devc_summary.append({**d,'initialC':vals[0],'maxC':max(vals),'frames':len(vals)})
  inventory.append({'scenario':folder.name,'fds':str(fds),'fdsSha256':sha(fds),'devc':devc_summary,'devcCsv':str(csvp),'devcCsvSha256':sha(csvp) if csvp else None})
  curves[folder.name]={}
  for name,point in CANDIDATES.items():
   choices=[]
   for s in m['slices']:
    axis={'PBX':0,'PBY':1,'PBZ':2}[s['plane']]
    if abs(point[axis]-s['planeCoordM'])>1e-4:continue
    ua={'X':0,'Y':1,'Z':2}[s['uAxis']];va={'X':0,'Y':1,'Z':2}[s['vAxis']]
    if not(s['uRangeM'][0]<=point[ua]<=s['uRangeM'][1] and s['vRangeM'][0]<=point[va]<=s['vRangeM'][1]):continue
    du=(s['uRangeM'][1]-s['uRangeM'][0])/(s['ni']-1);dv=(s['vRangeM'][1]-s['vRangeM'][0])/(s['nj']-1)
    ui=round((point[ua]-s['uRangeM'][0])/du);vi=round((point[va]-s['vRangeM'][0])/dv)
    actual=list(point);actual[ua]=s['uRangeM'][0]+ui*du;actual[va]=s['vRangeM'][0]+vi*dv
    dist=math.dist(actual,point);choices.append((dist,du*dv,s,ui,vi,actual))
   if not choices:
    stats.append({'scenario':folder.name,'candidate':name,'covered':False});continue
   _,_,s,ui,vi,actual=min(choices,key=lambda c:(c[0],c[1]));raw=fds.parent/s['sourceFile'];bounds,frames=raw_slice_frames(raw)
   values=[];times=[];index=ui+s['ni']*vi
   with raw.open('rb') as f:
    for t,offset,n in frames:
     assert n==s['ni']*s['nj']*4
     f.seek(offset+index*4);v=struct.unpack('<f',f.read(4))[0];assert math.isfinite(v);times.append(t);values.append(v)
   # Independent byte audit of matching exported frames catches orientation/index mistakes.
   binary=(folder/s['asset']).read_bytes();q=s['quantization'];step=q['scaleC']/(255 if q['scaleMode']=='SPAN' else 1);lookup={round(t,4):v for t,v in zip(times,values)}
   for i,t in enumerate(s['frameTimesS']):
    assert binary[i*s['ni']*s['nj']+index]==max(0,min(255,round((lookup[round(t,4)]-q['baseC'])/step)))
   curve={'requestedFdsM':point,'sampledFdsM':actual,'quantity':'FDS GAS TEMPERATURE (not wall surface/thermocouple)','timesS':times,'temperatureC':values,'source':str(raw),'sourceSha256':sha(raw),'gridDistanceM':math.dist(point,actual),'plane':s['plane'],'gridStepM':[du,dv]}
   curves[folder.name][name]=curve
   slopes=[(values[i+1]-values[i])/(times[i+1]-times[i]) for i in range(len(times)-1)]
   # 10s secant limits sample jitter; positive temperature increment >=10C onset.
   onset=next((t for t,v in zip(times,values) if v-values[0]>=10),None)
   stats.append({'scenario':folder.name,'candidate':name,'covered':True,'sampleFdsM':actual,'gridDistanceM':curve['gridDistanceM'],'frames':len(times),'initialC':values[0],'maxC':max(values),'riseC':max(values)-values[0],'peakTimeS':times[values.index(max(values))],'maxSlopeCPerS':max(slopes),'rmsSlopeCPerS':math.sqrt(sum(v*v for v in slopes)/len(slopes)),'onsetPlus10S':onset})
 # 只有140MW有体数据。屋顶候选附近的粗网格节点落入源OBST包络，不能把该值当作屋顶实测/有效气相曲线。
 folder=ROOT/'public/assets/results/HV-01-140MW';vm=json.loads((folder/'volume/manifest.json').read_text());v=next(x for x in vm['volumes'] if x['meshIndex']==2)
 pt=CANDIDATES['roof'];dims=[v['ni'],v['nj'],v['nk']];xb=v['meshXb'];indices=[round((pt[i]-xb[2*i])/(xb[2*i+1]-xb[2*i])*(dims[i]-1)) for i in range(3)];xyz=[xb[2*i]+indices[i]*(xb[2*i+1]-xb[2*i])/(dims[i]-1) for i in range(3)]
 data=(folder/v['asset']).read_bytes();idx=(indices[2]*v['nj']+indices[1])*v['ni']+indices[0];q=v['quantization'];values=[q['baseC']+data[i*v['voxelCount']+idx]*q['scaleC'] for i in range(v['frameCount'])]
 geom=json.loads((ROOT/'public/assets/geometry/scene_master.json').read_text());intersects=[s['id'] for s in geom['solids']+geom['surfaces'] if all(s['xb'][2*i]-.001<=xyz[i]<=s['xb'][2*i+1]+.001 for i in range(3))]
 (OUT/'roof-volume-diagnostic.json').write_text(json.dumps({'scenario':'HV-01-140MW','requested':pt,'sampled':xyz,'source':v['sourceFile'],'sourceAssetSha256':sha(folder/v['asset']),'intersectsObst':intersects,'maskSolidVoxelCount':v['maskSolidVoxelCount'],'usableForRecommendation':False,'reason':'单工况量化体数据且节点在OBST包络；有效掩码未排除实体，无法确认屋顶气相/表面语义','timesS':v['frameTimesS'],'decodedC':values},ensure_ascii=False),encoding='utf8')
 (OUT/'candidate-curves.json').write_text(json.dumps(curves,ensure_ascii=False),encoding='utf8')
 derived=ROOT/'public/assets/monitor-v3';derived.mkdir(exist_ok=True)
 (derived/'beam-curves.json').write_text(json.dumps({k:v['beam'] for k,v in curves.items()},ensure_ascii=False),encoding='utf8')
 (OUT/'monitor-analysis.json').write_text(json.dumps({'candidates':CANDIDATES,'statistics':stats,'sourceInventory':inventory},ensure_ascii=False,indent=2),encoding='utf8')
 with (OUT/'monitor-statistics.csv').open('w',encoding='utf-8-sig',newline='') as f:
  w=csv.DictWriter(f,fieldnames=list(next(x for x in stats if x['covered']).keys()));w.writeheader();w.writerows(stats)
 for name in CANDIDATES:
  a=[s for s in stats if s['candidate']==name and s['covered']];print(name,'covered',len(a),'rise range',([min(x['riseC'] for x in a),max(x['riseC'] for x in a)] if a else None))
if __name__=='__main__':main()

