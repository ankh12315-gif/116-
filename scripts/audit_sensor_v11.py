"""Read-only FDS audit. New derived curves only; never overwrite existing assets."""
from pathlib import Path
import json,re,struct,math,hashlib
from audit_delivery import raw_slice_frames
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/v11';OUT.mkdir(exist_ok=True)
assets=ROOT/'public/assets'
baseline={str(p.relative_to(assets)):hashlib.sha256(p.read_bytes()).hexdigest() for p in assets.rglob('*') if p.is_file() and 'sensors-v11' not in p.parts}
(OUT/'asset-baseline.json').write_text(json.dumps(baseline),encoding='utf8')
cab=json.loads((assets/'scenarios/cabinets.json').read_text())['cabinets']
report=[];curves={}
for folder in sorted((assets/'results').iterdir()):
 m=json.loads((folder/'manifest.json').read_text());fds=next((ROOT/x['path'] for x in m['sourceFiles'] if x['path'].endswith('.fds')),ROOT/m['dataProvenance'].get('sourceDirectory','')/(m['chid']+'.fds'))
 text=fds.read_text(encoding='utf8');smv=fds.with_suffix('.smv').read_text()
 volumes=re.findall(r'SMOK[FGE]3D[^\n]*\n\s*([^\n]+)\n\s*TEMPERATURE\s*\n',smv)
 solids=[]
 for block in re.findall(r'&OBST\b.*?/',text,re.S):
  match=re.search(r'XB\s*=\s*([\d.eE+,\s-]+)',block)
  if match:
   vals=[float(v) for v in match[1].strip().rstrip(',').split(',') if v.strip()]
   if len(vals)==6:solids.append(vals)
 def inside(pt):return any(all(b[2*i]-1e-5<=pt[i]<=b[2*i+1]+1e-5 for i in range(3)) for b in solids)
 curves[folder.name]={};coverage=[]
 for c in cab:
  anchor=c['burnerCenterFdsM'];wanted=[anchor[0],anchor[1],1.5];choices=[]
  for s in m['slices']:
   if s['plane']!='PBZ' or abs(s['planeCoordM']-1.5)>1e-4:continue
   dx=(s['uRangeM'][1]-s['uRangeM'][0])/(s['ni']-1);dy=(s['vRangeM'][1]-s['vRangeM'][0])/(s['nj']-1)
   for j in range(s['nj']):
    for i in range(s['ni']):
     pt=[s['uRangeM'][0]+i*dx,s['vRangeM'][0]+j*dy,1.5];d=math.dist(wanted,pt)
     if d<=.8 and not inside(pt):choices.append((d,dx*dy,s,i,j,pt))
  if not choices:coverage.append({'cabinetId':c['id'],'covered':False,'reason':'No verified air node within 0.8m of source anchor at z=1.5m'});continue
  _,_,s,i,j,pt=min(choices,key=lambda v:(v[0],v[1]));raw=fds.parent/s['sourceFile'];_,frames=raw_slice_frames(raw);values=[];times=[]
  with raw.open('rb') as f:
   for t,offset,n in frames:
    assert n==s['ni']*s['nj']*4;f.seek(offset+(i+s['ni']*j)*4);v=struct.unpack('<f',f.read(4))[0];assert math.isfinite(v);times.append(t);values.append(v)
  curve={'sampledFdsM':pt,'requestedFdsM':wanted,'quantity':'FDS GAS TEMPERATURE','locationKind':'CABINET_NEAR_AIR_NOT_VERIFIED_INTERIOR','timesS':times,'temperatureC':values,'source':str(raw),'sourceSha256':hashlib.sha256(raw.read_bytes()).hexdigest(),'sceneMode':'windowed','cabinetId':c['id']}
  curves[folder.name][c['id']]=curve;coverage.append({'cabinetId':c['id'],'covered':True,'sampledFdsM':pt,'distanceM':math.dist(pt,wanted),'frames':len(values),'initialC':values[0],'maxC':max(values)})
 report.append({'scenarioId':folder.name,'fds':str(fds),'temperatureVolumeSources':volumes,'cabinetPoints':coverage})
 print(folder.name,'volume',len(volumes),'covered',len(curves[folder.name]),flush=True)
derived=assets/'sensors-v11';derived.mkdir(exist_ok=True)
(derived/'cabinet-curves.json').write_text(json.dumps(curves,ensure_ascii=False),encoding='utf8')
(OUT/'coverage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
