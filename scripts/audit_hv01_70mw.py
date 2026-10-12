"""Read-only, targeted comparison with the user's HV-01 70 MW source results."""
from pathlib import Path
import csv, hashlib, json, re, struct
from build_fields_v7 import records
from convert_s3d import decompress, parse_s3d_index
from convert_fds_outputs import read_meshes_from_fds
from audit_delivery import raw_slice_frames

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / '116-gaoya-window/116-gaoya-1-70mw'
SID = 'HV-01-70MW'
CHID = '116-gaoya-1-70mw'
def read(p): return json.loads(p.read_text(encoding='utf8'))
def sha(b): return hashlib.sha256(b).hexdigest()

smvv = (SOURCE / (CHID + '.smvv')).read_bytes()
strings = [b.decode('utf-16-le') for b in re.findall(rb'(?:[\x20-\x7e]\x00){5,}', smvv)]
report = {'scenario': SID, 'source': str(SOURCE), 'smvvBytes': len(smvv),
          'smvvReferencedSmv': [s for s in strings if s.endswith('.smv')],
          'smvvOldAbsolutePaths': [s for s in strings if s.startswith('D:/')],
          'volumes': [], 'slices': [], 'sampleTimes': []}
smv = (SOURCE / (CHID + '.smv')).read_text(encoding='utf8')
meshes = read_meshes_from_fds(str(SOURCE / (CHID + '.fds')))
temps = []
for kind in ['temperature-v11', 'fields-v7']:
    folder = ROOT / 'public/assets' / kind / SID
    manifest = read(folder / 'manifest.json')
    assert manifest['scenarioId'] == SID
    for v in manifest['volumes']:
        raw = (SOURCE / v['asset']).read_bytes()
        assert sha(raw) == sha((folder / v['asset']).read_bytes()) == v['sourceSha256']
        assert re.search(re.escape(v['asset']) + r'\s*\n\s*' + re.escape(v['quantity']), smv)
        xb, ijk = meshes[v['meshIndex'] - 1]
        assert v['meshXb'] == list(xb)
        dims = [v['ni'], v['nj'], v['nk']]
        assert dims == [n+1 for n in ijk]
        rs = records(raw); index, _ = parse_s3d_index(str(SOURCE / v['asset']) + '.sz')
        assert len(rs) == 1 + 3 * len(v['frames'])
        for i, f in enumerate(v['frames']):
            tr, nr, dr = rs[1+i*3:4+i*3]
            t = struct.unpack_from('<f', raw, tr[0])[0]
            n, c = struct.unpack_from('<2i', raw, nr[0])
            assert t == f['timeS'] and dr[0] == f['offset'] and dr[1] == c == f['length']
            assert abs(t-index[i][0]) < .001 and n == index[i][1] and c == index[i][2]
            assert n == dims[0]*dims[1]*dims[2]
        # Every rendered compressed frame, not just a sample of frames.
        for f in v['frames']:
            q = decompress(raw[f['offset']:f['offset']+f['length']], dims[0]*dims[1]*dims[2])
            assert max(q) == f['maxByte'] and max(q) <= 254
        if kind == 'temperature-v11':
            assert v['baseC'] == 20 and v['perLsbC'] == 1980/254
            temps.append(v)
        report['volumes'].append({'quantity': v['quantity'], 'mesh': v['meshIndex'],
            'sha256': sha(raw), 'identical': True, 'decodedFrames': len(v['frames']),
            'firstS': v['frames'][0]['timeS'], 'lastS': v['frames'][-1]['timeS']})
    for s in manifest.get('slices', []):
        source = SOURCE / s['sourceFile']
        raw = source.read_bytes(); bounds, frames = raw_slice_frames(source)
        export = (folder / s['asset']).read_bytes()
        assert sha(raw) == s['sourceSha256'] and len(frames) == s['frameCount']
        payload = b''.join(raw[o:o+n] for t,o,n in frames)
        assert payload == export and all(t == s['frameTimesS'][i] for i,(t,o,n) in enumerate(frames))
        report['slices'].append({'asset':s['asset'], 'frames':len(frames), 'allFloat32BytesIdentical':True})

# Full-resolution original float slices (five horizontal + eleven extra planes).
thermal = ROOT / 'public/assets/thermal-view-v4' / SID
manifest = read(thermal / 'manifest.json')
for s in manifest['slices']:
    raw = (SOURCE / s['sourceFile']).read_bytes(); bounds, frames = raw_slice_frames(SOURCE / s['sourceFile'])
    assert b''.join(raw[o:o+n] for t,o,n in frames) == (thermal / s['asset']).read_bytes()
    assert all(t == s['frameTimesS'][i] for i,(t,o,n) in enumerate(frames))
    report['slices'].append({'asset':s['asset'], 'frames':len(frames), 'allFloat32BytesIdentical':True})

for requested in [0, 1.8, 3.6, 9, 30, 60, 300]:
    f = min(temps[0]['frames'],key=lambda f:abs(f['timeS']-requested))
    max_q = max(min(v['frames'],key=lambda f:abs(f['timeS']-requested))['maxByte'] for v in temps)
    report['sampleTimes'].append({'requestedS':requested, 'volumeFrameS':f['timeS'],
        'unmaskedVolumeMaxC':20+max_q*1980/254})
with (SOURCE / (CHID + '_hrr.csv')).open(encoding='utf8') as stream:
    rows = list(csv.reader(stream))[2:]
original_hrr = [(float(r[0]),float(r[1])) for r in rows]
web_hrr = read(ROOT / 'public/assets/results' / SID / 'hrr.json')
assert len(original_hrr) == len(web_hrr['timesS'])
time_error=max(abs(t-wt) for (t,q),wt in zip(original_hrr,web_hrr['timesS']))
hrr_error=max(abs(q-wq) for (t,q),wq in zip(original_hrr,web_hrr['hrrKW']))
assert time_error<=.000051 and hrr_error<=.000051
report['hrr'] = {'matchesWithinExportRounding':True, 'maxTimeErrorS':time_error, 'maxHRRErrorKW':hrr_error,
    'frames':len(original_hrr), 'sampledPeakKW':max(q for t,q in original_hrr)}
report['visualizationFindings'] = {
    'smvvSliceReferences':len([s for s in strings if s.endswith('.sf')]),
    'smvvTemperatureVolumeReferences':[s for s in strings if s.endswith('_3.s3d')],
    'webTemperatureRangeC':[20,1200],
    'webMode':'semi-transparent ray-marched temperature volume, independently overlaid by soot opacity',
    'webReadout':'maximum of the selected original float32 slices, not maximum of the whole volume',
    'browserComparedTimeS':3.605975866317749,
    'limitations':['SMVV settings were identified by string references, not fully deserialized.',
        'The original PyroSim screen, active slice selection, color range and camera were not supplied; no pixel equivalence is claimed.',
        'Temperature rendering mixes samples along rays; smoke is composited afterwards and can obscure thermal colors.',
        'An exact FDS time uses the nearest available output frame; no online FDS re-simulation occurs.']}
out = ROOT / 'docs/v11/hv01-70mw-source-check.json'
out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'volumesVerified':len(report['volumes']), 'volumeFramesDecoded':sum(v['decodedFrames'] for v in report['volumes']),
    'slicesVerified':len(report['slices']), 'hrr':report['hrr'], 'samples':report['sampleTimes'], 'report':str(out)},ensure_ascii=False))
