"""Independent record boundaries, source SHAs and raw SF payload comparison; emit JS decoder fixtures."""
import json,hashlib,struct
from pathlib import Path
from convert_s3d import decompress
from audit_delivery import raw_slice_frames
R=Path(__file__).resolve().parents[1];verified=0;fixtures=[];floatValues=0
for folder in sorted((R/'public/assets/fields-v7').iterdir()):
 m=json.loads((folder/'manifest.json').read_text());original=json.loads((R/'public/assets/results'/folder.name/'manifest.json').read_text());fds=next((R/x['path'] for x in original['sourceFiles'] if x['path'].endswith('.fds')),R/original['dataProvenance'].get('sourceDirectory','')/(original['chid']+'.fds'))
 for s in m['slices']:
  raw=fds.parent/s['sourceFile'];assert hashlib.sha256(raw.read_bytes()).hexdigest()==s['sourceSha256'];bounds,frames=raw_slice_frames(raw);export=(folder/s['asset']).read_bytes();pos=0
  with raw.open('rb') as f:
   for (t,o,n),mt in zip(frames,s['frameTimesS']):
    assert t==mt;f.seek(o);assert f.read(n)==export[pos:pos+n];pos+=n;floatValues+=n//4
  assert pos==len(export) and len(frames)==s['frameCount']
 for v in m['volumes']:
  b=(folder/v['asset']).read_bytes();assert hashlib.sha256(b).hexdigest()==v['sourceSha256']==hashlib.sha256(Path(v['source']).read_bytes()).hexdigest()
  for fi in [0,1,2,5,16,100,500,1000]:
   fr=v['frames'][fi];start=fr['offset'];end=start+fr['length'];assert struct.unpack_from('<i',b,start-4)[0]==fr['length']==struct.unpack_from('<i',b,end)[0];data=decompress(b[start:end],v['ni']*v['nj']*v['nk']);assert max(data)==fr['maxByte'];fixtures.append({'scenario':folder.name,'asset':v['asset'],'frameIndex':fi,'sum':sum(data),'first':list(data[:8]),'last':list(data[-8:])});verified+=1
baseline=json.loads((R/'docs/v7/baseline-assets.json').read_text());changed=[p for p,h in baseline.items() if hashlib.sha256((R/p).read_bytes()).hexdigest()!=h];assert not changed
(R/'docs/v7/decoder-fixtures.json').write_text(json.dumps(fixtures),encoding='utf8');(R/'docs/v7/asset-verification.json').write_text(json.dumps({'baselineAssetsUnchanged':len(baseline),'changed':changed,'newFloat32ValuesBitVerified':floatValues,'independentSmokeAndHRRFrameChecks':verified,'sourceCopiesBitIdentical':True},indent=2),encoding='utf8');print(floatValues,verified,len(baseline),'PASS')
