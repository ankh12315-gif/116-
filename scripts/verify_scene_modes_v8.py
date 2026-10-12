"""Independent V8 verifier: no converter imports, no original-file writes."""
import hashlib,json,struct,re
from pathlib import Path
R=Path(__file__).resolve().parents[1]
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def records(b):
 pos=0;out=[]
 while pos<len(b):
  n=struct.unpack_from('<i',b,pos)[0];assert n>=0 and pos+n+8<=len(b)
  assert struct.unpack_from('<i',b,pos+n+4)[0]==n
  out.append((pos+4,n));pos+=n+8
 assert pos==len(b);return out
def decode(b,n):
 out=bytearray();i=0
 while i<len(b):
  value=b[i];i+=1
  if value==255:
   assert i+2<=len(b);value,count=b[i:i+2];i+=2;assert count>0;out.extend([value]*count)
  else:out.append(value)
 assert len(out)==n;return out
baseline=read(R/'docs/v8/baseline-assets.json')
assert all(sha(R/p)==h for p,h in baseline.items())
index=read(R/'public/assets/scenes/windowless/scenarios.json')['scenarios'];assert len(index)==17
assert len({s['id'] for s in index})==17 and any(s['boundaryVariant']==150 for s in index)
fixtures=[];floats=0;volumes=0;slices=0;sourceFiles=0
for s in index:
 sid=s['id'];root=R/'public/assets/scenes/windowless';m=read(root/'results'/sid/'manifest.json')
 assert m['sceneMode']=='windowless' and m['scenarioId']==sid and m['status']=='READY'
 for f in m['sourceFiles']:assert sha(Path(f['path']))==f['sha256'];sourceFiles+=1
 geom=read(root/'geometries'/f'{sid}.json');assert geom['sceneMode']=='windowless' and geom['scenarioId']==sid
 assert geom['sourceSha256']==sha(Path(s['inputFile']))
 controls=[x for x in geom['solids']+geom['surfaces'] if x.get('controlDevice')]
 smv=Path(s['inputFile']).with_suffix('.smv').read_text(encoding='utf-8');actual=[float(m[1]) for m in re.finditer(r'HIDE_OBST\s+\d+\s*\n\s*\d+\s+([\d.Ee+-]+)',smv)];assert len(actual)==6 and all(t==s['openingAtS'] for t in actual)
 assert len(controls)==6 and all(x['disappearAtS']==s['openingAtS'] for x in controls)
 for kind in ['thermal','fields']:
  dest=root/kind/sid;fm=read(dest/'manifest.json');assert fm['scenarioId']==sid and fm['sceneMode']=='windowless'
  for sl in fm['slices']:
   raw=Path(sl['source']).read_bytes();assert hashlib.sha256(raw).hexdigest()==sl['sourceSha256']
   rs=records(raw);assert len(rs[:4])==4 and len(rs[3])==2
   expected=bytearray();times=[]
   for (to,tn),(vo,vn) in zip(rs[4::2],rs[5::2]):
    assert tn==4 and vn==sl['ni']*sl['nj']*4;times.append(struct.unpack_from('<f',raw,to)[0]);expected.extend(raw[vo:vo+vn])
   assert len(times)==sl['frameCount']==1001 and times==sl['frameTimesS']
   assert expected==(dest/sl['asset']).read_bytes();floats+=len(expected)//4;slices+=1
  for v in fm.get('volumes',[]):
   b=(dest/v['asset']).read_bytes();assert hashlib.sha256(b).hexdigest()==v['sourceSha256']==sha(Path(v['source']))
   rs=records(b);assert rs[0][1]==32 and (len(rs)-1)//3==len(v['frames'])==1001
   hd=struct.unpack_from('<8i',b,rs[0][0]);assert hd[:2]==(1,0)
   assert [hd[3]-hd[2]+1,hd[5]-hd[4]+1,hd[7]-hd[6]+1]==[v['ni'],v['nj'],v['nk']]
   for i in [0,2,16,1000]:
    fr=v['frames'][i];tr,nr,dr=rs[1+i*3:4+i*3];assert struct.unpack_from('<f',b,tr[0])[0]==fr['timeS']
    n,c=struct.unpack_from('<2i',b,nr[0]);assert n==v['ni']*v['nj']*v['nk'] and c==dr[1]==fr['length'] and dr[0]==fr['offset']
    a=decode(b[dr[0]:dr[0]+c],n);assert max(a)==fr['maxByte']<=254
    fixtures.append(dict(scenario=sid,asset=v['asset'],frameIndex=i,sum=sum(a),first=list(a[:8]),last=list(a[-8:])))
   volumes+=1
print('V8 independent PASS',len(index),'cases',floats,'bit-identical Float32 values',volumes,'source-identical volumes',len(baseline),'unchanged assets',flush=True)
(R/'docs/v8/decoder-fixtures.json').write_text(json.dumps(fixtures),encoding='utf-8')
(R/'docs/v8/asset-verification.json').write_text(json.dumps(dict(cases=len(index),baselineAssetsUnchanged=len(baseline),changed=[],float32ValuesBitVerified=floats,slices=slices,sourceIdenticalVolumes=volumes,independentRleFrames=len(fixtures),originalSourceFilesShaVerified=sourceFiles),indent=2),encoding='utf-8')
