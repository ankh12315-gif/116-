"""Read-only FDS audit; write new V8 assets only. Never runs FDS or old converters."""
import json,re,struct,hashlib,shutil,copy,math,collections
from pathlib import Path
from build_scene import build_geometry_from_fds,parse_namelists,fstr,fnums,classify_obst,surface_family
from convert_fds_outputs import parse_smv,parse_devc,parse_hrr,read_meshes_from_fds
from audit_delivery import raw_slice_frames
from build_fields_v7 import records
from convert_s3d import decompress,parse_s3d_index
ROOT=Path(__file__).resolve().parents[1];NEW=Path('D:/可视化/无窗');OUT=ROOT/'public/assets/scenes';DOC=ROOT/'docs/v8'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,o):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(o,ensure_ascii=False,indent=2),encoding='utf-8')
def break_time(p):return int(next(x.name[:-1] for x in p.parents if re.fullmatch(r'\d+s',x.name)))
def binary(p,data):
 if p.exists():assert p.read_bytes()==data;return
 p.write_bytes(data)
def subtract(x,h):
 flat=[i for i in range(3) if x[2*i]==x[2*i+1]]
 if len(flat)>1:return [x]
 axes=[i for i in range(3) if i not in flat]
 if any(not h[2*i]<=x[2*i]<=h[2*i+1] for i in flat):return [x]
 lo=[max(x[2*i],h[2*i]) for i in range(3)];hi=[min(x[2*i+1],h[2*i+1]) for i in range(3)]
 if any(hi[i]<=lo[i] for i in axes):return [x]
 rem=list(x);pieces=[]
 for i in axes:
  if rem[2*i]<lo[i]:a=rem.copy();a[2*i+1]=lo[i];pieces.append(a);rem[2*i]=lo[i]
  if rem[2*i+1]>hi[i]:a=rem.copy();a[2*i]=hi[i];pieces.append(a);rem[2*i+1]=hi[i]
 return pieces
def geometry(p,sid,mode):
 s=p.read_text(encoding='utf-8-sig');g=build_geometry_from_fds(str(p),p.stem);smv=p.with_suffix('.smv').read_text();controls={}
 for m in re.finditer(r'DEVICE_ACT\s+([^\n]+)\n\s*\d+\s+([\d.Ee+-]+)\s+0',smv):controls[m[1].strip()]=float(m[2])
 deviceTimes=controls.copy();hideEvents=[{'meshIndex':int(m[1]),'meshObstIndex':int(m[2]),'timeS':float(m[3])} for m in re.finditer(r'HIDE_OBST\s+(\d+)\s*\n\s*(\d+)\s+([\d.Ee+-]+)',smv)]
 if hideEvents:
  assert len(hideEvents)==6 and len({e['timeS'] for e in hideEvents})==1;controls['TIMER->OUT']=hideEvents[0]['timeS']
 ctrl={fstr(b,'ID'):fstr(b,'DEVC_ID') for n,b in parse_namelists(s) if n=='OBST'}
 template=json.loads((ROOT/'public/assets/geometry/scene_master.json').read_text());solids=[];surfaces=[];families=collections.Counter()
 for i,o in enumerate(g['obsts']):
  pieces=[o['xb']]
  for h in g['holes']:pieces=[a for x in pieces for a in subtract(x,h['xb'])]
  for pi,xb in enumerate(pieces):
   kind,role,conf,reason=classify_obst({**o,'xb':xb},g['room_bbox']);fam=surface_family(o);families[fam]+=1
   rec={'i':i*100+pi,'id':o['id'],'xb':xb,'fam':fam,'role':role,'conf':conf,'reason':reason,'kind':kind,'sourceObstIndex':i}
   if ctrl.get(o['id']):
    rec['controlDevice']=ctrl[o['id']];rec['deviceActivatedAtS']=deviceTimes[ctrl[o['id']]];rec['disappearAtS']=controls.get(ctrl[o['id']]);assert rec['disappearAtS'] is not None,'controlled geometry missing actual DEVICE_ACT'
   (solids if kind=='SOLID' else surfaces).append(rec)
 burners=[{'xb':v['xb'],'center':[(v['xb'][2*i]+v['xb'][2*i+1])/2 for i in range(3)]} for v in g['vents'] if v['surf_id']=='burner']
 template.update(sceneMode=mode,scenarioId=sid,geometryEvents=hideEvents,deviceActivationTimesS=deviceTimes,sourceSha256=sha(p),generatedFrom={'masterChid':p.stem,'masterFile':str(p),'sourceFiles':[str(p)],'note':'Original coordinates; HOLE subtraction; actual SMV HIDE_OBST removal times (not rounded DEVICE_ACT).'},coordinateSystem={**template['coordinateSystem'],'bbox':g['room_bbox']},meshes=g['meshes'],solids=solids,surfaces=surfaces,holes=g['holes'],surfaceDefs=g['surf_defs'],fireSourceVents=burners,meshBoundaryVents=[{'id':v['id'],'xb':v['xb']} for v in g['vents'] if v['surf_id']=='OPEN'],stats={**template['stats'],'obstTotal':len(g['obsts']),'solidCount':len(solids),'surfaceCount':len(surfaces),'holeCount':len(g['holes']),'familyCount':dict(families)})
 write(OUT/mode/'geometries'/f'{sid}.json',template)
 return template,g,controls,burners
def build():
 DOC.mkdir(exist_ok=True)
 baseline=DOC/'baseline-assets.json'
 if not baseline.exists():write(baseline,{p.relative_to(ROOT).as_posix():sha(p) for p in (ROOT/'public/assets').rglob('*') if p.is_file()})
 old=[]
 for folder in sorted((ROOT/'public/assets/results').iterdir()):
  m=json.loads((folder/'manifest.json').read_text());p=next((ROOT/x['path'] for x in m['sourceFiles'] if x['path'].endswith('.fds')),ROOT/m['dataProvenance'].get('sourceDirectory','')/(m['chid']+'.fds'))
  scene,g,c,b=geometry(p,folder.name,'windowed');old.append({'id':folder.name,'fds':str(p),'sha256':sha(p),'obst':len(g['obsts']),'holes':len(g['holes']),'controls':c,'burner':b})
 scenarios=[];cabinets={};curves={};candidateCurves={};audit=[];verifiedValues=0;verifiedFrames=0
 for p in sorted(NEW.rglob('*.fds'),key=lambda p:('diya' in p.stem,break_time(p))):
  high='gaoya' in p.stem;cab='HV-01' if high else 'LV-01';breakS=break_time(p);sid=f'WL-{cab}-'+('40MW' if high else 'FIRE')+f'-B{breakS}';case=OUT/'windowless/results'/sid;primary=OUT/'windowless/thermal'/sid;fields=OUT/'windowless/fields'/sid
  smv=p.with_suffix('.smv').read_text();version=re.search(r'FDSVERSION\s+(\S+)',smv)[1];assert version.startswith('FDS-6.8.0');assert 'FDS completed successfully' in p.with_suffix('.out').read_text(errors='replace')
  scene,g,controls,burners=geometry(p,sid,'windowless');assert len(burners)==1
  mesh=read_meshes_from_fds(str(p));slices=[];timesBySlice={};rawBySlice={}
  for sl in parse_smv(str(p.with_suffix('.smv'))):
   bnds,frames=raw_slice_frames(p.parent/sl['file']);assert list(bnds)==[sl[x] for x in ['i1','i2','j1','j2','k1','k2']]
   xb,ijk=mesh[sl['meshIndex']-1];step=[(xb[2*i+1]-xb[2*i])/ijk[i] for i in range(3)];axis=next((i for i in range(3) if bnds[2*i]==bnds[2*i+1]),None)
   if axis is None:continue
   coord=xb[2*axis]+bnds[2*axis]*step[axis];plane=['PBX','PBY','PBZ'][axis]
   if not ((plane=='PBZ' and coord in [1.5,3]) or (plane=='PBX' and abs(coord-11.5)<1e-5) or (plane=='PBY' and abs(coord+12)<1e-5)):continue
   raw=p.parent/sl['file'];head=raw.read_bytes()[:34];assert b'TEMPERATURE' in head
   axes=[i for i in range(3) if i!=axis];ua,va=axes;ni=bnds[2*ua+1]-bnds[2*ua]+1;nj=bnds[2*va+1]-bnds[2*va]+1;payload=bytearray();lo=float('inf');hi=-lo
   with raw.open('rb') as f:
    for t,o,n in frames:
     assert n==ni*nj*4;f.seek(o);a=f.read(n);v=struct.unpack('<'+str(n//4)+'f',a);assert all(math.isfinite(x) for x in v);lo=min(lo,min(v));hi=max(hi,max(v));payload.extend(a);verifiedValues+=n//4
   meta={'id':raw.stem,'asset':raw.stem+'.f32','sourceFile':raw.name,'sourceSha256':sha(raw),'source':str(raw),'meshIndex':sl['meshIndex'],'meshXb':xb,'plane':plane,'planeCoordM':coord,'uAxis':'XYZ'[ua],'vAxis':'XYZ'[va],'uRangeM':[xb[2*ua]+bnds[2*ua]*step[ua],xb[2*ua]+bnds[2*ua+1]*step[ua]],'vRangeM':[xb[2*va]+bnds[2*va]*step[va],xb[2*va]+bnds[2*va+1]*step[va]],'ni':ni,'nj':nj,'frameCount':len(frames),'frameTimesS':[x[0] for x in frames],'dataMinC':lo,'dataMaxC':hi,'storageEncoding':'FLOAT32_LE','quantization':{'scaleMode':'SPAN','bits':8,'baseC':20,'scaleC':1180,'minC':20,'maxC':1200},'maskAsset':None}
   dest=primary if plane=='PBZ' and coord==3 else fields;dest.mkdir(parents=True,exist_ok=True);binary(dest/meta['asset'],payload);assert (dest/meta['asset']).read_bytes()==payload;slices.append(meta);rawBySlice[meta['id']]=raw
  assert any(x['plane']=='PBZ' and x['planeCoordM']==3 for x in slices)
  candidateCurves[sid]={}
  for name,pt in {'beam':[11.5,-12,4.5],'wall':[12.5,-10.5,3],'cabinet':[10.5,-13.5,1.5]}.items():
   choices=[]
   for sl in slices:
    axis=['PBX','PBY','PBZ'].index(sl['plane']);ua='XYZ'.index(sl['uAxis']);va='XYZ'.index(sl['vAxis'])
    if abs(pt[axis]-sl['planeCoordM'])>1e-5 or not(sl['uRangeM'][0]<=pt[ua]<=sl['uRangeM'][1] and sl['vRangeM'][0]<=pt[va]<=sl['vRangeM'][1]):continue
    du=(sl['uRangeM'][1]-sl['uRangeM'][0])/(sl['ni']-1);dv=(sl['vRangeM'][1]-sl['vRangeM'][0])/(sl['nj']-1);ui=round((pt[ua]-sl['uRangeM'][0])/du);vi=round((pt[va]-sl['vRangeM'][0])/dv);actual=pt.copy();actual[ua]=sl['uRangeM'][0]+ui*du;actual[va]=sl['vRangeM'][0]+vi*dv;choices.append((math.dist(actual,pt),du*dv,sl,ui+sl['ni']*vi,actual))
   if not choices:continue
   _,_,sl,ix,actual=min(choices,key=lambda a:a[:2]);raw=rawBySlice[sl['id']];_,frames=raw_slice_frames(raw);values=[]
   with raw.open('rb') as f:
    for t,o,n in frames:f.seek(o+ix*4);values.append(struct.unpack('<f',f.read(4))[0])
   curve={'sampledFdsM':actual,'requestedFdsM':pt,'quantity':'FDS GAS TEMPERATURE','timesS':[x[0] for x in frames],'temperatureC':values,'source':str(raw),'sourceSha256':sha(raw),'sceneMode':'windowless','cabinetId':cab,'openingAtS':controls.get('TIMER->OUT'),'powerMW':40 if high else None}
   candidateCurves[sid][name]=curve
   if name=='beam':curves[sid]=curve
  volumes=[]
  for m in re.finditer(r'SMOK[FGE]3D[ \t]+(\d+)[^\n]*\n\s*(\S+)\s*\n\s*(SOOT DENSITY|HRRPUV)\s*\n[^\n]*\n\s*([^\n]+)',smv):
   mi=int(m[1]);raw=p.parent/m[2];a=raw.read_bytes();rs=records(a);assert rs[0][1]==32;hd=struct.unpack_from('<8i',a,rs[0][0]);assert hd[:2]==(1,0);dims=[hd[3]-hd[2]+1,hd[5]-hd[4]+1,hd[7]-hd[6]+1];xb,ijk=mesh[mi-1];assert dims==[i+1 for i in ijk];size=math.prod(dims);assert (len(rs)-1)%3==0;index,_=parse_s3d_index(str(raw)+'.sz');fr=[]
   for fi in range((len(rs)-1)//3):
    tr,nr,dr=rs[1+3*fi:4+3*fi];assert tr[1]==4 and nr[1]==8;t=struct.unpack_from('<f',a,tr[0])[0];n,c=struct.unpack_from('<2i',a,nr[0]);assert n==size and c==dr[1];decoded=decompress(a[dr[0]:dr[0]+c],n);mx=max(decoded);assert mx<=254;it,ir,ic,im=index[fi];assert abs(t-it)<.001 and ir==n and ic==c
    if m[3]=='SOOT DENSITY':assert abs(mx-im)<=1
    fr.append({'timeS':t,'offset':dr[0],'length':c,'maxByte':mx});verifiedFrames+=1
   fields.mkdir(parents=True,exist_ok=True)
   if not (fields/raw.name).exists():shutil.copyfile(raw,fields/raw.name)
   assert sha(raw)==sha(fields/raw.name)
   volumes.append({'asset':raw.name,'source':str(raw),'sourceSha256':sha(raw),'meshIndex':mi,'meshXb':xb,'ni':dims[0],'nj':dims[1],'nk':dims[2],'quantity':m[3],'storageEncoding':'FDS676_RLE_OPACITY_254' if m[3]=='SOOT DENSITY' else 'FDS676_RLE_HRRPUV_254','dxM':(xb[1]-xb[0])/ijk[0],'hrrClipKWPerM3':1200,'frames':fr})
  assert volumes and curves.get(sid)
  for dest,ss in [(primary,[x for x in slices if x['plane']=='PBZ' and x['planeCoordM']==3]),(fields,[x for x in slices if not(x['plane']=='PBZ' and x['planeCoordM']==3)])]:write(dest/'manifest.json',{'scenarioId':sid,'sceneMode':'windowless','scaleMode':'SPAN','storageEncoding':'FLOAT32_LE','slices':ss,'volumes':volumes if dest==fields else []})
  dev=parse_devc(str(p.with_name(p.stem+'_devc.csv')));hrr=parse_hrr(str(p.with_name(p.stem+'_hrr.csv')));cols=[i for i,name in enumerate(dev['ids']) if name.startswith('THCP')];assert cols
  vals=[max(dev['values'][i][j] for i in cols) for j in range(len(dev['times']))];times=dev['times'];pt=[d['xyz'] for d in g['devcs'] if (d['id'] or '').startswith('THCP') and d['xyz']];env=[min(q[i] for q in pt) if side==0 else max(q[i] for q in pt) for i in range(3) for side in range(2)]
  end=min(times[-1],hrr['times'][-1],*(x['frameTimesS'][-1] for x in slices),*(v['frames'][-1]['timeS'] for v in volumes));assert end>=1799.9
  write(case/'series.json',{'timesS':times,'fireSourceMaxC':vals,'sensorCount':len(cols),'aggregation':'MAX_OVER_THERMOCOUPLE_IN_FIRE_SOURCE_REGION','sensorEnvelopeFdsM':env,'sensorScopeNote':'真实起火区域热电偶；不是逐柜实测传感器','sourceFile':str(p.with_name(p.stem+'_devc.csv'))})
  write(case/'hrr.json',{'timesS':hrr['times'],'hrrKW':hrr['hrrKW']})
  sf=[{'path':str(x),'sha256':sha(x)} for x in [p,p.with_suffix('.smv'),p.with_suffix('.out'),p.with_name(p.stem+'_hrr.csv'),p.with_name(p.stem+'_devc.csv')]]
  write(case/'manifest.json',{'scenarioId':sid,'sceneMode':'windowless','status':'READY','scaleMode':'SPAN','chid':p.stem,'timeRangeS':[0,end],'seriesFile':'series.json','hrrFile':'hrr.json','slices':[],'sourceFiles':sf,'units':{'time':'s','temperature':'C'},'hrr':{'peakKW':hrr['peakKW'],'peakTimeS':hrr['times'][hrr['hrrKW'].index(hrr['peakKW'])],'sourceFile':str(p.with_name(p.stem+'_hrr.csv')),'frameCount':len(hrr['times']),'sampling':'FULL_RESOLUTION'},'dataProvenance':{'origin':'V8_USER_UPLOADED_OUTPUT','sourceDirectory':str(p.parent),'sourceFdsSha256':sha(p)},'geometryFile':f'/assets/scenes/windowless/geometries/{sid}.json'})
  scenarios.append({'id':sid,'sceneMode':'windowless','cabinetId':cab,'zone':'HIGH' if high else 'LOW','powerOptionMW':40 if high else None,'openingAtS':controls.get('TIMER->OUT'),'boundaryVariant':breakS,'nominalPeakHRRKW':g['surf_defs']['burner']['hrrpua']*abs((burners[0]['xb'][1]-burners[0]['xb'][0])*(burners[0]['xb'][3]-burners[0]['xb'][2])),'inputFile':str(p),'chid':p.stem,'tEndS':end,'availability':'READY','blockedReason':None,'outputFound':{'devc':True,'hrr':True,'smv':True,'fdsCompletedSuccessfully':True,'caseDir':str(p.parent)}})
  if breakS==0:cabinets[cab]={'id':cab,'zone':'HIGH' if high else 'LOW','burnerCenterFdsM':burners[0]['center'],'burnerXbFdsM':burners[0]['xb'],'sourceChid':p.stem,'envelopeVerified':False,'envelopeStatus':'SOURCE_BURNER_ONLY','sensorMappingStatus':'FIRE_REGION_DEVC','sensorCount':len(cols)}
  row={'id':sid,'source':str(p),'sha256':sha(p),'fdsVersion':version,'obst':len(g['obsts']),'holes':len(g['holes']),'geometryBounds':g['room_bbox'],'controlsActualS':controls,'sfTotal':len(parse_smv(str(p.with_suffix('.smv')))),'exportedSlices':len(slices),'volumeFiles':len(volumes),'hrrFrames':len(hrr['times']),'devcFrames':len(times),'timeRangeS':[0,end],'completed':True};audit.append(row);print(sid,'ready',flush=True)
 write(OUT/'windowless/scenarios.json',{'scenarios':scenarios});write(OUT/'windowless/cabinets.json',{'cabinets':list(cabinets.values())});write(OUT/'windowless/beam-curves.json',curves);write(OUT/'windowless/candidate-curves.json',candidateCurves)
 write(DOC/'source-audit.json',{'existingWindowed':old,'newWindowless':audit,'labelNote':'用户场景名称；原场景含六个常驻构件，新场景含对应受控移除构件和柜体HOLE；未提供玻璃破裂材料模型。不是永久封闭无开口房间。','float32ValuesVerified':verifiedValues,'rleFramesVerified':verifiedFrames})
 unchanged=json.loads(baseline.read_text());assert all(sha(ROOT/k)==v for k,v in unchanged.items());print('BASELINE',len(unchanged),'UNCHANGED',flush=True)
if __name__=='__main__':build()
