"""Fill slice coverage gaps from validated real 3D temperature nodes, never synthetic curves."""
from pathlib import Path
import json,math,sys
from convert_s3d import decompress
ROOT=Path(__file__).resolve().parents[1];assets=ROOT/'public/assets';file=assets/'sensors-v11/cabinet-curves.json'
curves=json.loads(file.read_text(encoding='utf8'));cabinets=json.loads((assets/'scenarios/cabinets.json').read_text())['cabinets'];added=[]
for sid,library in curves.items():
 base=assets/'temperature-v11'/sid;manifest=json.loads((base/'manifest.json').read_text(encoding='utf8'))
 for cabinet in cabinets:
  if cabinet['id'] in library:continue
  desired=[*cabinet['burnerCenterFdsM'][:2],1.5];choices=[]
  for v in manifest['volumes']:
   mask=(base/v['maskAsset']).read_bytes();dims=[v['ni'],v['nj'],v['nk']];xb=v['meshXb']
   for k in range(dims[2]):
    for j in range(dims[1]):
     for i in range(dims[0]):
      idx=(k*dims[1]+j)*dims[0]+i
      if not mask[idx]:continue
      pt=[xb[2*a]+[i,j,k][a]*(xb[2*a+1]-xb[2*a])/(dims[a]-1) for a in range(3)];d=math.dist(pt,desired)
      if d<=.8:choices.append((d,v,idx,pt))
  if not choices:
   added.append({'scenarioId':sid,'cabinetId':cabinet['id'],'covered':False,'reason':'No verified air node within 0.8m; do not substitute a remote cabinet/room sensor'})
   print(sid,cabinet['id'],'UNAVAILABLE',flush=True);continue
  d,v,idx,pt=min(choices,key=lambda c:c[0]);binary=(base/v['asset']).read_bytes();values=[]
  for f in v['frames']:
   q=decompress(binary[f['offset']:f['offset']+f['length']],v['ni']*v['nj']*v['nk'])[idx];values.append(v['baseC']+q*v['perLsbC'])
  library[cabinet['id']]={'sampledFdsM':pt,'requestedFdsM':desired,'quantity':'FDS GAS TEMPERATURE','locationKind':'CABINET_NEAR_AIR_NOT_VERIFIED_INTERIOR','timesS':[f['timeS'] for f in v['frames']],'temperatureC':values,'source':v['source'],'sourceSha256':v['sourceSha256'],'sceneMode':'windowed','cabinetId':cabinet['id'],'sampling':'VALID_AIR_VOLUME_NODE','quantizationStepC':v['perLsbC'],'gridDistanceM':d,'clipping':v['semantics']}
  added.append({'scenarioId':sid,'cabinetId':cabinet['id'],'sampledFdsM':pt,'gridDistanceM':d,'frames':len(values),'stepC':v['perLsbC']});print(sid,cabinet['id'],pt,flush=True)
file.write_text(json.dumps(curves,ensure_ascii=False),encoding='utf8')
(ROOT/'docs/v11/cabinet-volume-fallback.json').write_text(json.dumps(added,ensure_ascii=False,indent=2),encoding='utf8')
