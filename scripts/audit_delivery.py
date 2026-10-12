"""只读全工况资产审计；--fix-clipped仅备份后补齐5个已证实饱和片元数据。"""
import argparse, csv, hashlib, json, math, re, shutil, struct
from convert_fds_outputs import read_meshes_from_fds
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def raw_slice_frames(p):
    """只读取Fortran记录头与时间，温度数据seek跳过，保留源帧偏移。"""
    frames=[];bounds=None;time=None
    with p.open('rb') as f:
        for _ in range(3):
            n=struct.unpack('<i',f.read(4))[0];f.seek(n,1);assert struct.unpack('<i',f.read(4))[0]==n
        while head:=f.read(4):
            n=struct.unpack('<i',head)[0];offset=f.tell();assert n>0
            if n==24 and bounds is None:bounds=struct.unpack('<6i',f.read(n))
            elif n==4:time=struct.unpack('<f',f.read(n))[0]
            else:
                assert time is not None;frames.append((time,offset,n));f.seek(n,1)
            assert struct.unpack('<i',f.read(4))[0]==n
    return bounds,frames

def audit_raw(m,folder,fds):
    meshes=read_meshes_from_fds(str(fds));verified=0
    for sl in m['slices']:
        raw=fds.parent/sl['sourceFile'];assert raw.is_file(),raw
        bounds,frames=raw_slice_frames(raw);assert bounds is not None
        dims=[bounds[i+1]-bounds[i]+1 for i in (0,2,4)]
        assert dims==[sl['gridDims'][k] for k in ('ni','nj','nk')]
        xb,ijk=meshes[sl['meshIndex']-1];assert all(abs(a-b)<0.0001 for a,b in zip(xb,sl['meshXb']))
        axis={'PBX':0,'PBY':1,'PBZ':2}[sl['plane']]
        assert abs(xb[axis*2]+bounds[axis*2]*(xb[axis*2+1]-xb[axis*2])/ijk[axis]-sl['planeCoordM'])<0.0002
        for u,ax in [('u',{'X':0,'Y':1}[sl['uAxis']]),('v',{'Y':1,'Z':2}[sl['vAxis']])]:
            expected=[xb[ax*2]+bounds[ax*2+j]*(xb[ax*2+1]-xb[ax*2])/ijk[ax] for j in (0,1)]
            assert all(abs(a-b)<0.0002 for a,b in zip(expected,sl[u+'RangeM'])),(m['scenarioId'],sl['asset'],u)
        frame_by_time={round(t,4):(offset,n) for t,offset,n in frames}
        assert all(round(t,4) in frame_by_time for t in sl['frameTimesS'])
        data=(folder/sl['asset']).read_bytes();pixels=sl['ni']*sl['nj'];q=sl['quantization'];step=q['scaleC']/(255 if q['scaleMode']=='SPAN' else 1)
        with raw.open('rb') as f:
            for fi in {0,sl['frameCount']//2,sl['frameCount']-1}:
                offset,n=frame_by_time[round(sl['frameTimesS'][fi],4)];assert n==pixels*4
                for pi in {0,pixels//4,pixels//2,3*pixels//4,pixels-1}:
                    f.seek(offset+pi*4);value=struct.unpack('<f',f.read(4))[0]
                    want=0 if not math.isfinite(value) else max(0,min(255,round((value-q['baseC'])/step)))
                    assert data[fi*pixels+pi]==want,(m['scenarioId'],sl['asset'],fi,pi)
                    verified+=1
    return verified

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--fix-clipped',action='store_true');parser.add_argument('--check-dist',action='store_true');parser.add_argument('--raw-source',action='store_true');args=parser.parse_args()
    rows=[];errors=[];fixes=[];sources=[]
    dirs=sorted((ROOT/'public/assets/results').iterdir())
    assert len(dirs)==16
    for folder in dirs:
        m=read(folder/'manifest.json');mode=m['scaleMode'];assert mode in ('SPAN','PER_LSB');assert m['scenarioId']==folder.name and m['status']=='READY'
        max_decoded=0;clipped=0;frame_counts=set()
        for sl in m['slices']:
            q=sl['quantization'];assert q['scaleMode']==mode and q['bits']==8
            data=(folder/sl['asset']).read_bytes();assert len(data)==sl['ni']*sl['nj']*sl['frameCount']
            assert len(sl['frameTimesS'])==sl['frameCount'] and all(a<b for a,b in zip(sl['frameTimesS'],sl['frameTimesS'][1:]))
            step=q['scaleC']/(255 if mode=='SPAN' else 1);upper=q['baseC']+255*step
            decoded=q['baseC']+max(data)*step;max_decoded=max(max_decoded,decoded)
            saturation=max(data)==255 and sl['dataMaxC']>upper
            assert saturation or abs(decoded-sl['dataMaxC'])<=step/2+0.011, (folder.name,sl['asset'])
            assert math.isfinite(decoded) and q['baseC']<=decoded<=upper
            if saturation:
                clipped+=1
                if sl.get('quantizationClipped') is not True:
                    fixes.append({'scenario':folder.name,'asset':sl['asset'],'manifestShaBefore':sha(folder/'manifest.json')})
                    if args.fix_clipped: sl['quantizationClipped']=True
            frame_counts.add(sl['frameCount'])
            gd=sl['gridDims'];expected=(gd['ni'],gd['nj']) if sl['plane']=='PBZ' else (gd['nj'],gd['nk']) if sl['plane']=='PBX' else (gd['ni'],gd['nk']);assert expected==(sl['ni'],sl['nj'])
            xb=sl['meshXb'];axis={'PBX':0,'PBY':2,'PBZ':4}[sl['plane']];assert xb[axis]-0.001<=sl['planeCoordM']<=xb[axis+1]+0.001
        if args.fix_clipped and any(f['scenario']==folder.name for f in fixes):
            backup=ROOT/'docs/codex-baseline-20261008/manifests'/folder.name;backup.mkdir(parents=True,exist_ok=True);shutil.copy2(folder/'manifest.json',backup/'manifest.json')
            (folder/'manifest.json').write_text(json.dumps(m,ensure_ascii=False,indent=1),encoding='utf-8')
        h=read(folder/'hrr.json');assert len(h['timesS'])==len(h['hrrKW'])==m['hrr']['frameCount']==1001 and m['hrr']['sampling']=='FULL_RESOLUTION'
        assert abs(max(h['hrrKW'])-m['hrr']['peakKW'])<0.001
        provenance=m['dataProvenance'];source_dir=ROOT/provenance.get('sourceDirectory','')
        fds_record=next((r for r in m['sourceFiles'] if r['path'].endswith('.fds')),None)
        fds=ROOT/fds_record['path'] if fds_record else source_dir/(m['chid']+'.fds')
        assert fds.is_file(),fds
        assert sha(fds)==provenance['sourceFdsSha256'],fds
        for r in m['sourceFiles']:
            p=ROOT/r['path'];assert p.is_file(),p
            if r.get('sha256'):assert sha(p)==r['sha256'],p
            sources.append({'scenario':folder.name,'path':str(p.resolve()),'sha256':sha(p)})
        if provenance['origin']=='V2_HANDBOX_RECALC': assert float(re.search(r'HRRPUA\s*=\s*([\d.Ee+-]+)',fds.read_text(encoding='utf-8')).group(1))==560000
        samples=audit_raw(m,folder,fds) if args.raw_source else None
        rows.append({'scenario':folder.name,'mode':mode,'sliceCount':len(m['slices']),'frameCount':','.join(map(str,sorted(frame_counts))),'stepC':round(step,6),'domainMaxC':upper,'decodedMaxC':round(max_decoded,4),'saturatedSlices':clipped,'hrrFrames':len(h['timesS']),'hrrPeakKW':m['hrr']['peakKW'],'sourceShaVerified':True,'rawSamplesVerified':samples})
    if args.check_dist:
        for p in (ROOT/'public/assets').rglob('*'):
            if p.is_file():
                d=ROOT/'dist/assets'/p.relative_to(ROOT/'public/assets')
                if not d.is_file() or sha(p)!=sha(d):errors.append('public/dist不一致：'+str(p))
    report={'scenarios':rows,'sources':sources,'metadataFixes':fixes,'distChecked':args.check_dist,'rawChecked':args.raw_source,'errors':errors}
    (ROOT/'docs/codex-asset-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    with (ROOT/'docs/codex-scenario-audit.csv').open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=rows[0].keys());w.writeheader();w.writerows(rows)
    if fixes and args.fix_clipped:
        (ROOT/'docs/codex-metadata-changes.json').write_text(json.dumps(fixes,indent=2),encoding='utf-8')
    for r in rows: print(r['scenario'],r['mode'],r['sliceCount'],r['frameCount'],r['decodedMaxC'],'PASS')
    print('16 scenarios /',sum(r['sliceCount'] for r in rows),'slices; source SHA verified; dist mismatches:',len(errors))
    if errors: raise SystemExit(1)

if __name__=='__main__': main()
