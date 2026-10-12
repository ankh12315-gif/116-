"""New derived assets only. Source FDS6.7.6 smoke records, no simulation run."""
import json,struct,hashlib,re,shutil,copy
from pathlib import Path
from convert_s3d import decompress,parse_s3d_index
from convert_fds_outputs import read_meshes_from_fds
from audit_delivery import raw_slice_frames
ROOT=Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def records(data):
 out=[];o=0
 while o<len(data):
  n=struct.unpack_from('<i',data,o)[0];assert n>=0 and o+8+n<=len(data) and struct.unpack_from('<i',data,o+4+n)[0]==n
  out.append((o+4,n));o+=n+8
 assert o==len(data);return out

def main():
 report=[]
 for folder in sorted((ROOT/'public/assets/results').iterdir()):
  m=json.loads((folder/'manifest.json').read_text());fds=next((ROOT/x['path'] for x in m['sourceFiles'] if x['path'].endswith('.fds')),ROOT/m['dataProvenance'].get('sourceDirectory','')/(m['chid']+'.fds'));smv=fds.with_suffix('.smv');text=smv.read_text();version=re.search(r'FDSVERSION\s+(\S+)',text)[1];assert version.startswith(('FDS6.7.6','FDS-6.8.0')),version
  meshes=read_meshes_from_fds(str(fds));out=ROOT/'public/assets/fields-v7'/folder.name;out.mkdir(parents=True,exist_ok=True);vol=[];sf=[]
  # Reuse V4 3m bytes. Add 1.5m horizontal and two true vertical cuts at full time resolution.
  for s in m['slices']:
   if not ((s['plane']=='PBZ' and abs(s['planeCoordM']-1.5)<1e-4) or (s['plane']=='PBX' and abs(s['planeCoordM']-11.5)<1e-4) or (s['plane']=='PBY' and abs(s['planeCoordM']+12)<1e-4)):continue
   raw=fds.parent/s['sourceFile'];bounds,frames=raw_slice_frames(raw);data=bytearray();lo=float('inf');hi=-lo;times=[]
   with raw.open('rb') as f:
    for t,o,n in frames:
     assert n==s['ni']*s['nj']*4;f.seek(o);b=f.read(n);v=struct.unpack('<'+str(n//4)+'f',b);lo=min(lo,min(v));hi=max(hi,max(v));data.extend(b);times.append(t)
   meta=copy.deepcopy(s);meta.update(asset=raw.stem+'.f32',storageEncoding='FLOAT32_LE',frameCount=len(times),frameTimesS=times,dataMinC=lo,dataMaxC=hi,sourceSha256=sha(raw));(out/meta['asset']).write_bytes(data);sf.append(meta)
  for match in re.finditer(r'SMOK[FGE]3D[ \t]+(\d+)[^\n]*\n\s*(\S+)\s*\n\s*(SOOT DENSITY|HRRPUV)\s*\n[^\n]*\n\s*([^\n]+)',text):
   mi=int(match[1]);raw=fds.parent/match[2];quantity=match[3];b=raw.read_bytes();rs=records(b);assert rs[0][1]==32;header=struct.unpack_from('<8i',b,rs[0][0]);assert header[:2]==(1,0);dims=[header[3]-header[2]+1,header[5]-header[4]+1,header[7]-header[6]+1];xb,ijk=meshes[mi-1];assert dims==[x+1 for x in ijk];size=dims[0]*dims[1]*dims[2];assert (len(rs)-1)%3==0
   index,_=parse_s3d_index(str(raw)+'.sz');frames=[];maxbyte=0;nonzero=0
   for fi in range((len(rs)-1)//3):
    tr,nr,dr=rs[1+3*fi:4+3*fi];assert tr[1]==4 and nr[1]==8;t=struct.unpack_from('<f',b,tr[0])[0];n,c=struct.unpack_from('<2i',b,nr[0]);assert n==size and c==dr[1];decoded=decompress(b[dr[0]:dr[0]+c],n);q=max(decoded);assert q<=254;maxbyte=max(maxbyte,q);nonzero+=int(q>0)
    it,ir,ic,imax=index[fi];assert abs(t-it)<.001 and ir==n and ic==c
    if quantity=='SOOT DENSITY':assert abs(q-imax)<=1
    frames.append({'timeS':t,'offset':dr[0],'length':c,'maxByte':q})
   asset=raw.name;shutil.copyfile(raw,out/asset);assert sha(raw)==sha(out/asset)
   vol.append({'asset':asset,'source':str(raw),'sourceSha256':sha(raw),'meshIndex':mi,'meshXb':xb,'ni':dims[0],'nj':dims[1],'nk':dims[2],'quantity':quantity,'sourceUnit':match[4].strip(),'storageEncoding':'FDS676_RLE_OPACITY_254' if quantity=='SOOT DENSITY' else 'FDS676_RLE_HRRPUV_254','dxM':(xb[1]-xb[0])/ijk[0],'hrrClipKWPerM3':1200,'frames':frames,'maxByte':maxbyte,'nonzeroFrames':nonzero})
  manifest={'scenarioId':folder.name,'fdsVersion':version,'storageEncoding':'FLOAT32_LE','scaleMode':m['scaleMode'],'slices':sf,'volumes':vol,'smokeEncodingNote':'SOOT file stores optical opacity q=round(254*(1-exp(-K*rho*dx))), not linear kg/m3. Render optical depth; do not invent density. Includes true t=0 record, not validity mask.'}
  (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf8');report.append({'scenario':folder.name,'fdsVersion':version,'slices':len(sf),'smokeMeshes':len([x for x in vol if x['quantity']=='SOOT DENSITY']),'fireMeshes':len([x for x in vol if x['quantity']=='HRRPUV']),'frames':len(vol[0]['frames']),'sourceSHAAndIndexAndRLEVerified':True,'smokeMaxByte':max(x['maxByte'] for x in vol if x['quantity']=='SOOT DENSITY')});print(report[-1],flush=True)
 (ROOT/'docs/v7/field-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
if __name__=='__main__':main()
