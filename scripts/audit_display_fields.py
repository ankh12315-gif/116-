"""Read-only check against user-designated windowed originals; no asset conversion."""
from pathlib import Path
import json,hashlib,struct,re
from build_fields_v7 import records
from convert_s3d import decompress,parse_s3d_index
from audit_delivery import raw_slice_frames
R=Path(__file__).resolve().parents[1]
roots=[R.parent/'116-diya-window',R.parent/'116-gaoya-window']
def sha(b):return hashlib.sha256(b).hexdigest()
def locate(v):
 target=v['sourceSha256']; candidates=[p for root in roots for p in root.rglob(v['asset'])]
 matches=[p for p in candidates if sha(p.read_bytes())==target]
 assert matches,('No identical designated source',v['source'])
 return matches[0],[(str(p),sha(p.read_bytes())) for p in candidates]
report={'cases':[],'volumes':0,'recordFrames':0,'decodedChecks':0,'slicePayloadChecks':0,'temperatureComparisons':[]}
for case in sorted((R/'public/assets/temperature-v11').iterdir()):
 tm=json.loads((case/'manifest.json').read_text());fm=json.loads((R/'public/assets/fields-v7'/case.name/'manifest.json').read_text());entry={'case':case.name,'sources':[]};temps={}
 for kind,m in [('temperature-v11',tm),('fields-v7',fm)]:
  for v in m['volumes']:
   p,candidates=locate(v);buf=p.read_bytes();assert sha(buf)==sha((R/'public/assets'/kind/case.name/v['asset']).read_bytes())
   smv=p.parent/(p.name.split('_')[0]+'.smv');text=smv.read_text()
   assert re.search(re.escape(v['asset'])+r'\s*\n\s*'+re.escape(v['quantity']),text)
   rs=records(buf);header=struct.unpack_from('<8i',buf,rs[0][0]);dims=[header[3]-header[2]+1,header[5]-header[4]+1,header[7]-header[6]+1];assert dims==[v['ni'],v['nj'],v['nk']]
   ix,_=parse_s3d_index(str(p)+'.sz');start=4 if len(rs)==4+3*len(v['frames']) else 1;skip=1 if start==4 else 0;n=dims[0]*dims[1]*dims[2]
   assert len(rs)==start+3*len(v['frames']) and len(ix)==len(v['frames'])+skip
   for fi,f in enumerate(v['frames']):
    tr,nr,dr=rs[start+fi*3:start+fi*3+3];t=struct.unpack_from('<f',buf,tr[0])[0];raw,comp=struct.unpack_from('<2i',buf,nr[0]);it,ir,ic,_=ix[fi+skip]
    assert t==f['timeS'] and raw==n==ir and comp==dr[1]==f['length']==ic and dr[0]==f['offset'] and abs(t-it)<.001
   checks={0,1,len(v['frames'])//2,len(v['frames'])-1,max(range(len(v['frames'])),key=lambda i:v['frames'][i]['maxByte'])}
   for fi in checks:
    f=v['frames'][fi];q=decompress(buf[f['offset']:f['offset']+f['length']],n);assert max(q)==f['maxByte'];report['decodedChecks']+=1
   report['volumes']+=1;report['recordFrames']+=len(v['frames'])
   entry['sources'].append({'quantity':v['quantity'],'mesh':v['meshIndex'],'source':str(p),'sha':sha(buf),'frames':len(v['frames']),'firstS':v['frames'][0]['timeS'],'lastS':v['frames'][-1]['timeS'],'otherDifferentCopies':[x for x,h in candidates if h!=sha(buf)]})
   if kind=='temperature-v11':temps[v['meshIndex']]=(v,p,buf)
  if kind=='fields-v7':
   for s in m['slices']:
    base=next(p.parent for v,p,b in temps.values() if v['meshIndex']==s['meshIndex']);p=base/s['sourceFile'];assert p.exists()
    assert sha(p.read_bytes())==s['sourceSha256'];bounds,frames=raw_slice_frames(p);export=(R/'public/assets'/kind/case.name/s['asset']).read_bytes();assert len(frames)==s['frameCount']
    offsets=[];pos=0
    for t,o,n in frames:offsets.append(pos);pos+=n
    assert pos==len(export)
    v,vp,buf=temps[s['meshIndex']];errors=[]
    with p.open('rb') as f:
     for fi in {0,1,len(frames)//2,len(frames)-1}:
      t,o,n=frames[fi];f.seek(o);payload=f.read(n);assert payload==export[offsets[fi]:offsets[fi]+n];assert t==s['frameTimesS'][fi];report['slicePayloadChecks']+=1
      vf=min(v['frames'],key=lambda fr:abs(fr['timeS']-t))
      if abs(vf['timeS']-t)>.002:continue
      q=decompress(buf[vf['offset']:vf['offset']+vf['length']],v['ni']*v['nj']*v['nk']);vals=struct.unpack('<'+str(n//4)+'f',payload);idx=0
      for k in range(bounds[4],bounds[5]+1):
       for j in range(bounds[2],bounds[3]+1):
        for i in range(bounds[0],bounds[1]+1):
         byte=q[(k*v['nj']+j)*v['ni']+i];actual=vals[idx];idx+=1
         if byte not in (0,254,255) and actual>20:errors.append(abs((v['baseC']+byte*v['perLsbC'])-actual))
    if errors:report['temperatureComparisons'].append({'case':case.name,'slice':s['asset'],'samples':len(errors),'maxErrorC':max(errors),'meanErrorC':sum(errors)/len(errors),'quantStepC':v['perLsbC']})
 report['cases'].append(entry);print(case.name,'verified',flush=True)
(R/'docs/v11/display-source-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print({k:v for k,v in report.items() if k not in ['cases','temperatureComparisons']});print('Temperature max comparisons',sorted(report['temperatureComparisons'],key=lambda x:x['maxErrorC'],reverse=True)[:5])
