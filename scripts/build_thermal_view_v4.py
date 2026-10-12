"""只读原始SF，另存3m水平截面完整真实帧；不重写results或运行FDS。"""
import json,struct,hashlib,copy
from pathlib import Path
from audit_delivery import raw_slice_frames
ROOT=Path(__file__).resolve().parents[1]
def main():
 reports=[]
 for folder in sorted((ROOT/'public/assets/results').iterdir()):
  original=json.loads((folder/'manifest.json').read_text());pr=original['dataProvenance'];fds=next((ROOT/x['path'] for x in original['sourceFiles'] if x['path'].endswith('.fds')),ROOT/pr.get('sourceDirectory','')/(original['chid']+'.fds'))
  out=ROOT/'public/assets/thermal-view-v4'/folder.name;out.mkdir(parents=True,exist_ok=True);slices=[]
  for s in original['slices']:
   if s['plane']!='PBZ' or abs(s['planeCoordM']-3)>1e-4:continue
   p=fds.parent/s['sourceFile'];bounds,frames=raw_slice_frames(p);pixels=s['ni']*s['nj'];data=bytearray();times=[];lo=float('inf');hi=-float('inf')
   with p.open('rb') as f:
    for t,offset,n in frames:
     assert n==pixels*4;f.seek(offset);raw=f.read(n);values=struct.unpack('<'+str(pixels)+'f',raw);lo=min(lo,min(values));hi=max(hi,max(values));times.append(t);data.extend(raw)
   meta=copy.deepcopy(s);meta.update(asset=s['sourceFile'].replace('.sf','.bin'),storageEncoding='FLOAT32_LE',frameCount=len(times),frameTimesS=times,dataMinC=lo,dataMaxC=hi,quantizationClipped=False,sourceSha256=hashlib.sha256(p.read_bytes()).hexdigest())
   (out/meta['asset']).write_bytes(data);slices.append(meta)
  assert slices
  manifest={'scenarioId':folder.name,'scaleMode':original['scaleMode'],'storageEncoding':'FLOAT32_LE','view':'真实3m水平截面，不代表整室3D体场','source':'RAW_FDS_SF_FULL_TIME_RESOLUTION','slices':slices}
  (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf8');reports.append({'scenario':folder.name,'slices':len(slices),'frames':slices[0]['frameCount'],'bytes':sum((out/s['asset']).stat().st_size for s in slices),'maxC':max(s['dataMaxC'] for s in slices)})
 (ROOT/'docs/v4/thermal-source-audit.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(reports,ensure_ascii=False))
if __name__=='__main__':main()
