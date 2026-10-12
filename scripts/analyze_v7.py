import json,math,itertools,struct
from pathlib import Path
import numpy as np
import matplotlib;matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap,Normalize
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'docs/v7';c=json.loads((ROOT/'docs/v3/candidate-curves.json').read_text());ids=sorted(c)
plt.rcParams.update({'font.family':'Microsoft YaHei','font.size':9,'axes.spines.top':False,'axes.spines.right':False,'axes.unicode_minus':False})
summary=[];fig,axes=plt.subplots(2,2,figsize=(12,7))
points={'wall':(12.5,-10.5,3),'roof':(6.75,-7.75,6),'beam':(11.5,-12,4.5),'cabinet':(10.5,-13.5,1.5)}
g=json.loads((ROOT/'public/assets/geometry/scene_master.json').read_text())
for ax,(name,xyz) in zip(axes.flat,points.items()):
 ax.set_title(f'{name} 固定气相候选 {xyz}');ax.set_xlabel('FDS相对时间 / s');ax.set_ylabel('温度 / ℃');ax.set_xlim(0,180);ax.grid(alpha=.15)
 hit=[s['id'] for s in g['solids']+g['surfaces'] if all(s['xb'][2*i]-.001<=xyz[i]<=s['xb'][2*i+1]+.001 for i in range(3))]
 if name=='roof':
  ax.set_xticks([]);ax.set_yticks([]);ax.set_xlabel('');ax.set_ylabel('');
  ax.text(.05,.65,'无该固定位置SF/DEVC覆盖\n原始烟气体输出不能替代温度曲线\n候选坐标落入两个OBST包络\n未认定为有效流体点，不伪造曲线',transform=ax.transAxes);summary.append({'candidate':name,'xyz':xyz,'covered':0,'obstIntersections':hit});continue
 metrics=[]
 for i,sid in enumerate(ids):
  curve=c[sid][name];t=np.array(curve['timesS']);v=np.array(curve['temperatureC']);ax.plot(t,v,label=sid,lw=.8,color=plt.cm.tab20(i),alpha=.85)
  slope=np.diff(v)/np.diff(t);onset=next((float(tt) for tt,vv in zip(t,v) if vv-v[0]>=10),None)
  metrics.append({'scenario':sid,'maxRiseC':float(v.max()-v[0]),'maxSlopeCPerS':float(slope.max()),'onsetPlus10S':onset,'earlyAmplitudeC':float(v[t<=180].max()-v[t<=180].min())})
 pairs=[]
 for cabinet in ['HV-01','HV-02']:
  group=[sid for sid in ids if sid.startswith(cabinet)];tt=np.arange(0,181,1)
  for a,b in itertools.combinations(group,2):
   va=np.interp(tt,c[a][name]['timesS'],c[a][name]['temperatureC']);vb=np.interp(tt,c[b][name]['timesS'],c[b][name]['temperatureC']);pairs.append({'a':a,'b':b,'rmse0To180C':float(np.sqrt(np.mean((va-vb)**2)))})
 summary.append({'candidate':name,'xyz':xyz,'covered':len(metrics),'obstIntersections':hit,'metrics':metrics,'sameCabinetPairRmse':pairs,'minSameCabinetPairRmseC':min(x['rmse0To180C'] for x in pairs)})
handles,labels=axes[0,0].get_legend_handles_labels();fig.legend(handles,labels,loc='lower center',ncol=4,fontsize=7);fig.suptitle('V7：四类固定位置真实气相曲线 · 前180秒 / 16工况');fig.tight_layout(rect=[0,.15,1,.96]);fig.savefig(OUT/'monitor-curves.png',dpi=160);fig.savefig(OUT/'monitor-curves.svg');plt.close(fig)
(OUT/'monitor-analysis.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
# Compare actual same-frame 3m field with all three fixed Celsius palettes, no numerical modification.
m=json.loads((ROOT/'public/assets/thermal-view-v4/HV-01-70MW/manifest.json').read_text());selected=[s for s in m['slices'] if s['planeCoordM']==3];maxC=max(s['dataMaxC'] for s in selected)
palettes=[('A 蓝绿黄红',[(20,'#1446dc'),(80,'#14be3c'),(200,'#fff000'),(500,'#ff4600'),(1200,'#a00000')]),('B 深蓝青绿黄橙红紫红',[(20,'#0a1464'),(50,'#00d2eb'),(100,'#00d25a'),(200,'#fff500'),(350,'#ff8c00'),(600,'#fa1e14'),(1200,'#c80096')]),('C Smokeview风格（选用）',[(20,'#0032d2'),(45,'#00aaff'),(80,'#00e187'),(160,'#e6fa00'),(300,'#ffa000'),(500,'#ff2d00'),(800,'#dc0014'),(1200,'#a0006e')])]
fig,axes=plt.subplots(1,3,figsize=(13,6))
for ax,(title,stops) in zip(axes,palettes):
 cmap=LinearSegmentedColormap.from_list('heat',[(float(t-20)/1180,color) for t,color in stops]);norm=Normalize(20,1200)
 for s in selected:
  data=np.fromfile(ROOT/'public/assets/thermal-view-v4/HV-01-70MW'/s['asset'],dtype='<f4').reshape(-1,s['nj'],s['ni']);fi=min(range(s['frameCount']),key=lambda i:abs(s['frameTimesS'][i]-1.8));field=data[fi];field=np.ma.masked_where(field<=20.01,field)
  im=ax.imshow(field,origin='lower',extent=[*s['uRangeM'],*s['vRangeM']],cmap=cmap,norm=norm,interpolation='nearest')
 ax.set_xlim(min(s['uRangeM'][0] for s in selected),max(s['uRangeM'][1] for s in selected));ax.set_ylim(min(s['vRangeM'][0] for s in selected),max(s['vRangeM'][1] for s in selected));
 ax.set_title(title);ax.set_xlabel('FDS X / m');ax.set_ylabel('FDS Y / m');ax.set_aspect('equal');fig.colorbar(im,ax=ax,label='℃',shrink=.6)
fig.suptitle('同一原始Float32温度场 · HV-01/70MW · 真实t=1.8s · 高度3m');fig.tight_layout();fig.savefig(OUT/'palette-comparison.png',dpi=160);fig.savefig(OUT/'palette-comparison.svg');plt.close(fig)
print([(x['candidate'],x['covered'],x.get('minSameCabinetPairRmseC')) for x in summary])
