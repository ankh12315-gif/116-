import { useEffect, useRef, useState } from 'react';
import { effectiveTime, useFireStore } from '../store/useFireStore';
import type { VolumeFrameInfo } from '../scene/ThermalVolume';
import VolumePanel from './VolumePanel';
import DeviceCard from './DeviceCard';
import StatusBar from './StatusBar';
import EventList from './EventList';
import ReleaseProfilePanel from './ReleaseProfilePanel';
import { describeSliceSet } from '../utils/coords';

export default function ProfessionalPanel({onClose, onHelp, frameInfo}: {onClose:()=>void;onHelp:()=>void;frameInfo:VolumeFrameInfo|null}) {
  const s=useFireStore();
  const closeRef=useRef<HTMLButtonElement>(null);
  const [range,setRange]=useState<'EARLY'|'ALL'>('EARLY');
  useEffect(()=>{const old=document.activeElement as HTMLElement|null;closeRef.current?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',key);return ()=>{document.removeEventListener('keydown',key);old?.focus();};},[onClose]);
  const q=describeSliceSet(s.slices);
  const end=range==='EARLY'?60:1800;
  const hrr=s.hrr;
  const peak=hrr?Math.max(1,...hrr.hrrKW):1;
  const points=hrr?.timesS.map((t,i)=>t<=end?`${40+t/end*300},${150-hrr.hrrKW[i]/peak*120}`:null).filter(Boolean).join(' ')??'';
  const energy=hrr?hrr.timesS.slice(1).reduce((sum,t,i)=>sum+(t-hrr.timesS[i])*(hrr.hrrKW[i]+hrr.hrrKW[i+1])/2,0)/1000:null;
  return <aside className="professional-panel panel" role="dialog" aria-modal="false" aria-label="专业分析">
    <div className="professional-heading"><div><h2>专业分析</h2><p>{s.activeScenarioId??'未选择工况'} · FDS预计算结果<br/>{s.futureOffsetS ? '未来' : '当前'}温度场查询 {effectiveTime(s).toFixed(1)} s</p></div><button ref={closeRef} className="btn" onClick={onClose}>返回简洁模式</button></div>
    <section className="analysis-section"><h3>温度场</h3>
      <button className="btn" aria-pressed={s.showSlices} onClick={s.toggleSlices}>{s.showSlices?'隐藏温度切片':'显示温度切片'}</button>
      <div className="analysis-options">{(['PBZ','PBX','PBY'] as const).map((p,i)=><button key={p} className={`chip ${s.slicePlane===p?'is-active':''}`} disabled={!s.slices.some(sl=>sl.plane===p)} onClick={()=>{s.setSlicePlane(p);s.setRenderMode('THERMAL_SLICE');}}>{['水平切片','纵向切片','横向切片'][i]}</button>)}</div>
      <p>{s.slicePlane} · {s.slices.filter(sl=>sl.plane===s.slicePlane).length}块网格补丁 · 最近邻真实帧</p>
      {q && <p>{q.formula}<br/>{q.minC}–{q.maxC} ℃ · {q.note} · {q.frameCount}帧<br/>{q.clipping}<br/>当前首片网格 {s.slices[0].ni}×{s.slices[0].nj} · 未覆盖区域无数据</p>}
      <VolumePanel frameInfo={frameInfo}/>
    </section>
    <section className="analysis-section"><h3>实际热释放率 · HRR</h3>
      {hrr?.sampling==='FULL_RESOLUTION'?<>
        <div className="analysis-options"><button className={`chip ${range==='EARLY'?'is-active':''}`} onClick={()=>setRange('EARLY')}>前60秒</button><button className={`chip ${range==='ALL'?'is-active':''}`} onClick={()=>setRange('ALL')}>完整过程</button></div>
        <svg viewBox="0 0 360 184" className="hrr-chart" role="img" aria-label={`真实HRR曲线，${hrr.timesS.length}个全分辨率采样，峰值${hrr.peakKW}kW`}>
          <path d="M40 25V150H340" stroke="#aaa59b" fill="none"/>
          <polyline points={points} fill="none" stroke="#9b493d" strokeWidth="1.8"/>
          <text x="40" y="16">{peak.toFixed(1)} kW</text><text x="40" y="174">0 s</text><text x="292" y="174">{end} s</text>
        </svg>
        <p>标称设定 {s.hrrInterpretation?.nominalPeakHRRKW??'—'} kW<br/>FDS实际峰值 {hrr.peakKW.toFixed(2)} kW @ {hrr.peakTimeS.toFixed(2)} s<br/>实际累计释放能量 {energy?.toFixed(2)} MJ（全序列梯形积分）<br/>{hrr.timesS.length}个全分辨率采样 · {hrr.sourceFile}</p>
        <p>标称设定与计算结果为不同物理量，差异成因未核验。高压火源计划短时释放约1秒；释放结束不代表温度已恢复安全。</p>
      </>:<p>当前工况无全分辨率HRR数据，曲线不可用。</p>}
      <details><summary>短时释放与采样口径详情</summary><ReleaseProfilePanel showCurve={false}/></details>
    </section>
    <details className="analysis-section"><summary>详细设备信息与监测点</summary><DeviceCard/></details>
    <details className="analysis-section"><summary>报警事件与阈值</summary><EventList/>
      <div className="threshold-fields">{(['warningC','alarmC','highZoneWarningC','highZoneAlarmC'] as const).map((k,i)=><label key={k}>{['低压预警℃','低压报警℃','高压预警℃','高压报警℃'][i]}<input type="number" value={s.thresholds[k]} onChange={e=>{const v=Number(e.target.value);if(Number.isFinite(v))s.updateThresholds({[k]:v});}}/></label>)}</div>
    </details>
    <details className="analysis-section"><summary>数据来源、时间栅格与实验说明</summary>
      <p>几何为主工况116-diya-1真实FDS模型；切换工况不会重建几何。起火标记为火源面中心，柜体外壳与墙顶语义尚未核验。</p>
      <p>来源：{s.provenance?.origin??'未标注'}<br/>源FDS SHA-256：<code>{s.provenance?.sourceFdsSha256??'未标注'}</code><br/>校验器：{s.provenance?.verifiedBy??'未标注'}</p>
      <StatusBar/><button className="btn" onClick={onHelp}>完整使用说明</button>
    </details>
    <details className="analysis-section"><summary>其他显示设置</summary>
      <div className="analysis-options">{(['ALL','HIGH','LOW'] as const).map((z,i)=><button key={z} className={`chip ${s.zoneFilter===z?'is-active':''}`} onClick={()=>s.setZoneFilter(z)}>{['全部区域','高压区域','低压区域'][i]}</button>)}</div>
      <button className="btn" onClick={s.toggleLabels}>{s.showCabinetLabels?'隐藏':'显示'}设备标签</button>
    </details>
  </aside>;
}
