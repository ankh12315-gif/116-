"""Add independently audited temperature volumes; existing FDS assets are read-only."""
from pathlib import Path
import json,struct,hashlib,shutil,re
from build_fields_v7 import records
from convert_s3d import decompress,parse_s3d_index
from convert_fds_outputs import read_meshes_from_fds
ROOT=Path(__file__).resolve().parents[1];report=[]
for folder in sorted((ROOT/'public/assets/results').iterdir()):
 m=json.loads((folder/'manifest.json').read_text());fds=next((ROOT/x['path'] for x in m['sourceFiles'] if x['path'].endswith('.fds')),ROOT/m['dataProvenance'].get('sourceDirectory','')/(m['chid']+'.fds'))
 meshes=read_meshes_from_fds(str(fds));out=ROOT/'public/assets/temperature-v11'/folder.name;out.mkdir(parents=True,exist_ok=True);vol=[]
 text=fds.read_text(encoding='utf8');obst=[]
 for b in re.findall(r'&OBST\b.*?/',text,re.S):
  r=re.search(r'XB\s*=\s*([\d.eE+,\s-]+)',b)
  if r:
   vals=[float(v) for v in r[1].strip().rstrip(',').split(',') if v.strip()]
   if len(vals)==6:obst.append(vals)
 for match in re.finditer(r'SMOK[FGE]3D[ \t]+(\d+)[^\n]*\n\s*(\S+)\s*\n\s*(TEMPERATURE)\s*\n',fds.with_suffix('.smv').read_text()):
  entry={'quantity':match[3],'file':match[2],'meshIndex':int(match[1])}
  if entry['quantity']!='TEMPERATURE':continue
  raw=fds.parent/entry['file'];buf=raw.read_bytes();rs=records(buf);mi=entry['meshIndex'];xb,ijk=meshes[mi-1];dims=[v+1 for v in ijk];size=dims[0]*dims[1]*dims[2];start=1
  assert (len(rs)-start)%3==0
  index,_=parse_s3d_index(str(raw)+'.sz');offsetindex=1 if start==4 else 0;frames=[]
  for fi in range((len(rs)-start)//3):
   tr,nr,dr=rs[start+3*fi:start+3*fi+3];t=struct.unpack_from('<f',buf,tr[0])[0];n,c=struct.unpack_from('<2i',buf,nr[0]);assert n==size and c==dr[1]
   decoded=decompress(buf[dr[0]:dr[0]+c],n);assert len(decoded)==n
   it,ir,ic,_=index[fi+offsetindex];assert abs(it-t)<.001 and ir==n and ic==c
   if start==1:assert max(decoded)<=254
   frames.append({'timeS':t,'offset':dr[0],'length':c,'maxByte':max(decoded)})
  # Conservative OBST mask; no claims of temperatures inside cabinet solids.
  mask=bytearray([1])*size;dx=[(xb[2*i+1]-xb[2*i])/ijk[i] for i in range(3)]
  for b in obst:
   ranges=[]
   for axis in range(3):
    import math
    lo=max(0,math.ceil((b[2*axis]-xb[2*axis])/dx[axis]-1e-6));hi=min(ijk[axis],math.floor((b[2*axis+1]-xb[2*axis])/dx[axis]+1e-6));ranges.append(range(lo,hi+1))
   for k in ranges[2]:
    for j in ranges[1]:
     for i in ranges[0]:mask[(k*dims[1]+j)*dims[0]+i]=0
  maskfile=raw.stem+'.mask';(out/maskfile).write_bytes(mask);shutil.copyfile(raw,out/raw.name)
  base,step=(20,1980/254)
  vol.append({'asset':raw.name,'maskAsset':maskfile,'meshIndex':mi,'meshXb':xb,'ni':dims[0],'nj':dims[1],'nk':dims[2],'quantity':'TEMPERATURE','baseC':base,'perLsbC':step,'storageEncoding':'RLE_TEMPERATURE','frames':frames,'source':str(raw),'sourceSha256':hashlib.sha256(buf).hexdigest(),'semantics':'V2 verified PER_LSB' if start==4 else 'FDS6.7.6 official smvv.f90: INT(254*(T-20)/(2000-20)); lower/upper clipped','maskedNodes':mask.count(0)})
 (out/'manifest.json').write_text(json.dumps({'scenarioId':folder.name,'sceneMode':'windowed','volumes':vol},ensure_ascii=False),encoding='utf8')
 report.append({'scenario':folder.name,'meshes':len(vol),'frames':[len(v['frames']) for v in vol],'quantization':[v['perLsbC'] for v in vol],'indexRleShaVerified':True});print(folder.name,len(vol),flush=True)
(ROOT/'docs/v11/volume-audit.json').write_text(json.dumps(report,indent=2),encoding='utf8')

