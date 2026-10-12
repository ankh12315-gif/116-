"""Offline descriptive comparison only; never extrapolate or run FDS."""
import json,csv,math,struct
from pathlib import Path
R=Path(__file__).resolve().parents[1];D=R/'docs/v8';A=R/'public/assets'
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def at(curve,t):
 ts=curve['timesS'];vs=curve['temperatureC']
 for i in range(1,len(ts)):
  if ts[i]>=t:return vs[i-1]+(vs[i]-vs[i-1])*(t-ts[i-1])/(ts[i]-ts[i-1])
 return vs[-1]
curves=read(A/'scenes/windowless/candidate-curves.json');rows=[]
for sid,points in curves.items():
 geom=read(A/'scenes/windowless/geometries'/f'{sid}.json')
 for name,c in points.items():
  ts=c['timesS'];vs=c['temperatureC'];pt=c['sampledFdsM'];occupied=[s['id'] for s in geom['solids'] if all(s['xb'][i*2]<pt[i]<s['xb'][i*2+1] for i in range(3)) and (s.get('disappearAtS') is None)]
  rows.append(dict(scenario=sid,candidate=name,coordinate=pt,frames=len(ts),maxC=max(vs),peakTimeS=ts[vs.index(max(vs))],riseC=max(vs)-vs[0],maxSampleRiseCPerS=max((vs[i]-vs[i-1])/(ts[i]-ts[i-1]) for i in range(1,len(ts))),staticSolidInterior=occupied,source=c['source']))
(D/'monitor-candidates.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
oldCurves=read(A/'monitor-v3/beam-curves.json');newCurves=read(A/'scenes/windowless/beam-curves.json');comparison=[]
for old,new in [('HV-01-40MW','WL-HV-01-40MW-B0'),('LV-01-FIRE','WL-LV-01-FIRE-B0')]:
 for t in [3.6,30,300,900]:
  for sid,mode in [(old,'windowed'),(new,'windowless')]:
   result=A/'results'/sid if mode=='windowed' else A/'scenes/windowless/results'/sid
   root=A/'thermal-view-v4'/sid if mode=='windowed' else A/'scenes/windowless/thermal'/sid
   m=read(root/'manifest.json');peaks=[];frames=[]
   for sl in m['slices']:
    ix=min(range(len(sl['frameTimesS'])),key=lambda i:abs(sl['frameTimesS'][i]-t));n=sl['ni']*sl['nj'];b=(root/sl['asset']).read_bytes();v=struct.unpack_from('<'+str(n)+'f',b,ix*n*4);peaks.append(max(v));frames.append(sl['frameTimesS'][ix])
   h=read(result/'hrr.json');hi=min(range(len(h['timesS'])),key=lambda i:abs(h['timesS'][i]-t))
   comparison.append(dict(scenario=sid,mode=mode,requestedTimeS=t,primaryFrameTimesS=frames,primary3mMaxC=max(peaks),beamInterpolatedC=at((oldCurves if mode=='windowed' else newCurves)[sid],t),hrrSampleTimeS=h['timesS'][hi],hrrKW=h['hrrKW'][hi],note='同查询物理时刻；各场取自己的最近真实帧。柜体HOLE/开口控制不同，非单因素通风实验。'))
(D/'comparison.json').write_text(json.dumps(comparison,ensure_ascii=False,indent=2),encoding='utf-8')
with (D/'comparison.csv').open('w',encoding='utf-8-sig',newline='') as f:
 w=csv.DictWriter(f,fieldnames=comparison[0].keys());w.writeheader();w.writerows(comparison)
print('Candidate curves:',len(rows),'covered; roof no valid gas-point evidence. Comparisons:',len(comparison),'PASS')
