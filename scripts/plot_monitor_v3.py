"""使用matplotlib从只读提取曲线生成报告图；不改变原FDS资产。"""
import csv,json,math
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'docs/v3'
curves=json.loads((OUT/'candidate-curves.json').read_text(encoding='utf8'))
plt.rcParams.update({'font.family':'Microsoft YaHei','axes.spines.top':False,'axes.spines.right':False,'font.size':9,'axes.unicode_minus':False})
ids=sorted(curves);colors=plt.cm.tab20.colors
def save(fig,name):
 fig.savefig(OUT/(name+'.png'),dpi=160,bbox_inches='tight');fig.savefig(OUT/(name+'.svg'),bbox_inches='tight');plt.close(fig)
fig,axes=plt.subplots(2,2,figsize=(12,7))
for ax,name,title in zip(axes.flat,['wall','beam','cabinet','roof'],['近墙气相 (12.5,−10.5,3)','梁下气相 (11.5,−12,4.5)','固定柜区气相 (10.5,−13.5,1.5)','屋顶中心候选 (6.75,−7.75,6)']):
 ax.set_title(title);ax.set_xlabel('FDS 相对起火时间 / s');ax.set_ylabel('气相温度 / ℃');ax.grid(alpha=.15)
 if name=='roof':ax.text(.05,.65,'16组均无该位置切片 / 固定热电偶\n仅140MW有体数据；近邻节点落入OBST\n不能认定为有效气相或屋顶表面温度\n不绘制虚构曲线',transform=ax.transAxes,linespacing=1.8);continue
 for i,sid in enumerate(ids):
  c=curves[sid][name];ax.plot(c['timesS'],c['temperatureC'],label=sid,color=colors[i],lw=.9,alpha=.9)
 ax.set_xlim(0,1800)
handles,labels=axes[0,0].get_legend_handles_labels();fig.legend(handles,labels,loc='lower center',ncol=4,fontsize=7,bbox_to_anchor=(.5,-.07));fig.suptitle('真实源 .sf float32 候选点对比 · 气相值不等同于实体/传感器温度');fig.tight_layout(rect=[0,.1,1,.96]);save(fig,'candidate-comparison')
fig,axes=plt.subplots(1,3,figsize=(14,4))
for ax,subset,title,limit in zip(axes,[[x for x in ids if x.startswith('HV-01')],[x for x in ids if x.startswith('HV-02')],[x for x in ids if x.startswith('LV')]],['HV-01 梁下点：短时释放响应','HV-02 梁下点：短时释放响应','低压工况：梁下点响应较弱'],[60,60,1800]):
 for sid in subset:
  c=curves[sid]['beam'];ax.plot(c['timesS'],c['temperatureC'],label=sid,lw=1)
 ax.set_title(title);ax.set_xlim(0,limit);ax.set_xlabel('FDS 相对时间 / s');ax.set_ylabel('温度 / ℃');ax.grid(alpha=.15);ax.legend(fontsize=7)
fig.suptitle('暂定单点 (11.5,−12,4.5) · 未证明能唯一识别起火位置或功率');fig.tight_layout();save(fig,'recommended-monitor')
c=curves['HV-01-70MW']['beam'];times=c['timesS'];raw=c['temperatureC'];sensor=[x+10 for x in raw];corrected=[x+min(20,y-x) for x,y in zip(raw,sensor)]
with (OUT/'correction-comparison.csv').open('w',encoding='utf-8-sig',newline='') as f:
 w=csv.writer(f);w.writerow(['fdsRelativeS','demoAbsoluteS_exampleOrigin6','source','originalFdsC','mockSensorC','deltaT','appliedDeltaC','correctedPointC','errorBeforeC','errorAfterC'])
 for t,a,b,d in zip(times,raw,sensor,corrected):w.writerow([t,6+t,'MOCK',a,b,b-a,min(20,b-a),d,abs(b-a),abs(b-d)])
fig,axes=plt.subplots(1,2,figsize=(11,3.8));ax=axes[0];ax.plot(times,raw,label='原始 FDS 气相');ax.plot(times,sensor,label='MOCK = FDS+10℃');ax.plot(times,corrected,'--',label='单点修正（与MOCK重合）');ax.set_xlim(0,60);ax.set_xlabel('FDS 相对时间 / s');ax.set_ylabel('温度 / ℃');ax.legend(fontsize=8);ax.grid(alpha=.15)
ax=axes[1];future=[i for i in range(61)];ax.plot(future,[10+.05*t for t in future],label='漂移MOCK修正前误差');ax.plot(future,[.05*t for t in future],label='冻结当前+10℃后的未来误差');ax.set_xlabel('冻结偏差后的未来间隔 / s');ax.set_ylabel('误差 / ℃');ax.legend(fontsize=8);ax.grid(alpha=.15)
fig.suptitle('演示校验：同点残差10→0℃是代数结果；漂移时未来30s仍误差1.5℃，不证明空间准确性');fig.tight_layout();save(fig,'correction-error')
(OUT/'correction-metrics.json').write_text(json.dumps({'source':'MOCK','scenario':'HV-01-70MW','samples':len(raw),'constantBiasC':10,'maeBeforeC':10,'maeAfterC':0,'rmseBeforeC':10,'rmseAfterC':0,'driftRateCPerS':.05,'frozenForecastError30C':1.5,'limitations':'同点同样本残差校验，不是独立物理验证；无三维场修正'},ensure_ascii=False,indent=2),encoding='utf8')
print('已生成3组PNG/SVG、1001行修正对照及误差指标')
