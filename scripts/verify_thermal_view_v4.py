"""独立逐帧核对新增Float32资产与原SF全部payload，并校验SHA/源网格。"""
import json,hashlib,struct
from pathlib import Path
from audit_delivery import raw_slice_frames
ROOT=Path(__file__).resolve().parents[1]
def main():
 checked=0;values=0
 for folder in (ROOT/'public/assets/thermal-view-v4').iterdir():
  m=json.loads((folder/'manifest.json').read_text());old=json.loads((ROOT/'public/assets/results'/folder.name/'manifest.json').read_text());pr=old['dataProvenance'];fds=next((ROOT/x['path'] for x in old['sourceFiles'] if x['path'].endswith('.fds')),ROOT/pr.get('sourceDirectory','')/(old['chid']+'.fds'));assert m['scaleMode']==old['scaleMode'] and m['storageEncoding']=='FLOAT32_LE'
  for sl in m['slices']:
   p=fds.parent/sl['sourceFile'];assert hashlib.sha256(p.read_bytes()).hexdigest()==sl['sourceSha256'];bounds,frames=raw_slice_frames(p);bin=(folder/sl['asset']).read_bytes();assert len(bin)==sl['ni']*sl['nj']*len(frames)*4
   assert len(frames)==sl['frameCount']==1001
   with p.open('rb') as f:
    for i,(t,offset,n) in enumerate(frames):
     assert t==sl['frameTimesS'][i];f.seek(offset);assert f.read(n)==bin[i*n:(i+1)*n];values+=n//4
   checked+=1
 result={'scenarios':16,'slices':checked,'floatValuesVerified':values,'rawPayloadBitIdentical':True,'sourceShaVerified':True}
 (ROOT/'docs/v4/lossless-verification.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(result)
if __name__=='__main__':main()
