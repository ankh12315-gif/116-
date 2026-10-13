import { useEffect, useRef, useState } from 'react';
import { effectiveTime, useFireStore } from '../store/useFireStore';
import { findSliceFrameIndex, queryCabinetTemperature } from '../data/scenarioProvider';
import { classifyTemperature, temperatureGradientCss } from '../utils/coords';
import {pointTemperature} from '../simulation/monitorCorrection';
import {monitorSnapshot,useAutomaticFire} from '../simulation/AutomaticFire';
import {useThermalView} from '../data/thermalView';
import {visualization} from '../config/visualization';
import { formatClock } from '../utils/format';

export function SimpleTopBar({onAnalysis, onHelp}: {onAnalysis:()=>void; onHelp:()=>void}) {
  const s = useFireStore();
  const [more, setMore] = useState(false);
  return <header className="simple-header">
    <div><h1>116配电室</h1><p>Fire Visualization</p></div>
    <div className="simple-header__actions">
      <span className={`system-state ${s.alarmState !== 'NORMAL' ? 'system-state--alarm' : ''}`}>
        ● {s.datasetStatus === 'LOADING' ? '加载中' : s.datasetStatus !== 'READY' ? '数据不可用' : s.alarmState === 'NORMAL' ? '数据就绪' : s.alarmState === 'FIRE_ALARM' ? '火灾报警' : '高温预警'}
      </span>
      <span className="header-scenario">{s.selectedCabinetId} {s.selectedPowerMW ? `${s.selectedPowerMW} MW` : '低压工况'}</span>
      <button className="btn" onClick={onAnalysis}>专业分析</button>
      <div className="more-wrap"><button className="btn" aria-expanded={more} onClick={()=>setMore(!more)}>更多设置</button>
      {more && <div className="more-menu panel">
        <button className="btn" onClick={()=>s.setMuted(!s.muted)}>{s.muted ? '恢复报警声音' : '静音报警声音'}</button>
        <button className="btn" onClick={s.toggleLabels}>{s.showCabinetLabels ? '隐藏设备标签' : '显示设备标签'}</button>
        <button className="btn" onClick={()=>{setMore(false);onHelp();}}>数据来源与使用说明</button>
      </div>}</div>
    </div>
  </header>;
}

export function SimpleDeviceCard() {
  const s = useFireStore();
  const cabinet=s.cabinets.find(c=>c.id===s.selectedCabinetId);
  if (!cabinet) return null;
  const q=queryCabinetTemperature(s.series,effectiveTime(s));
  const level=classifyTemperature(q.valueC,cabinet.zone==='HIGH'?s.thresholds.highZoneWarningC:s.thresholds.warningC,cabinet.zone==='HIGH'?s.thresholds.highZoneAlarmC:s.thresholds.alarmC);
  const status=level==='UNKNOWN'?'数据不可用':level==='FIRE_ALARM'?'高温 · 达报警阈值':level==='TEMPERATURE_WARNING'?'温度异常':'未达温度阈值';
  return <aside className={`simple-device panel ${cabinet.zone==='HIGH'?'simple-device--high':''}`} aria-label="选中设备信息">
    <div className="device-heading"><strong>{cabinet.id}</strong><span>{cabinet.zone==='HIGH'?'高压':'低压'} · 起火位置</span></div>
    {cabinet.zone==='HIGH' && <div className="power-options" role="group" aria-label="标称火源功率">
      {[40,70,100,140].map(mw=><button key={mw} className={`chip ${s.selectedPowerMW===mw?'is-active':''}`} aria-pressed={s.selectedPowerMW===mw} onClick={()=>void s.selectPower(mw)}>{mw} MW</button>)}
    </div>}
    <p className="device-scenario">{cabinet.zone==='HIGH'?`${s.selectedPowerMW} MW 标称火源`:'低压 FDS 火灾工况'}</p>
    <div className="simple-temperature"><span>{s.futureOffsetS?'未来':'当前'}起火区域测点最高温</span><strong>{q.valueC===null?'—':q.valueC.toFixed(1)} <small>℃</small></strong></div>
    <p className={`device-state ${level==='FIRE_ALARM'?'device-state--alarm':''}`}>{status}</p>
    <p className="source-caption">FDS预计算结果 · 起火区域热电偶<br/> · 其他柜体温度未接入</p>
    {s.datasetError && <p role="alert" className="data-error">{s.datasetError}</p>}
  </aside>;
}

export function SceneTools() {
  const s=useFireStore();
  const [choose,setChoose]=useState(false);
  return <div className="scene-tools-wrap">
    <div className="scene-tools panel" role="group" aria-label="房间显示工具">
      <button className="btn" aria-expanded={choose} onClick={()=>setChoose(!choose)}>选择柜体</button>
      <button className="btn" aria-pressed={!s.showRoof} title="按几何形态隐藏高处水平面，屋顶语义未核验" onClick={s.toggleRoof}>{s.showRoof?'打开屋顶':'合上屋顶'}</button>
      <button className="btn" aria-pressed={s.wallOpacity<1} title="按几何形态调整立面透明度，墙体语义未核验" onClick={()=>s.setWallOpacity(s.wallOpacity<1?1:0.22)}>透明显示</button>
    </div>
    {choose && <div className="device-picker panel" aria-label="选择起火柜体">
      <p>也可以直接点击房间内的起火位置标记</p>
      {(['HIGH','LOW'] as const).map(zone=><div key={zone}><strong>{zone==='HIGH'?'高压':'低压'}</strong><div className="device-picker__grid">{s.cabinets.filter(c=>c.zone===zone).map(c=><button key={c.id} className={`chip ${s.selectedCabinetId===c.id?'is-active':''}`} onClick={()=>{setChoose(false);void s.selectCabinet(c.id);}}>{c.id}</button>)}</div></div>)}
    </div>}
  </div>;
}

export function SimpleTimeline() {
  const s=useFireStore();
  const automatic=useAutomaticFire();
  const thermal=useThermalView();
  const currentPoint=monitorSnapshot(s.currentTimeS);
  const futurePointRaw=pointTemperature(automatic.curves[s.activeScenarioId??''],effectiveTime(s));
  const futurePointCorrected=futurePointRaw===null?null:futurePointRaw+currentPoint.appliedDeltaC;
  const [futureOpen,setFutureOpen]=useState(false);
  const [fullTimeline,setFullTimeline]=useState(false);
  const [jumpOpen,setJumpOpen]=useState(false);
  const last=useRef<number|null>(null);
  useEffect(()=>{setFutureOpen(false);setJumpOpen(false);setFullTimeline(false);},[s.sceneRevision]);
  const ready=s.datasetStatus==='READY' && s.series!==null && automatic.phase==='FIRE' && automatic.sceneMode===s.sceneMode && !s.sceneSwitching && !automatic.switching;
  const future=s.futureOffsetS!==null;
  useEffect(()=>{
    if (s.playback!=='PLAYING'||future||!ready) {last.current=null;return;}
    let id=0;
    const tick=(ts:number)=>{if(last.current!==null) s.stepTime(Math.min((ts-last.current)/1000,0.25));last.current=ts;id=requestAnimationFrame(tick);};
    id=requestAnimationFrame(tick);
    return ()=>{cancelAnimationFrame(id);last.current=null;};
  },[s.playback,future,ready,s.stepTime]);
  const currentSlices=thermal.scenarioId===s.activeScenarioId?thermal.slices:s.slices;
  const frame=currentSlices[0]?findSliceFrameIndex(currentSlices[0],effectiveTime(s)):null;
  const frameTime=frame?currentSlices[0].frameTimesS[frame.index]:null;
  return <div className="simple-timeline" aria-label="火灾过程播放">
    {(futureOpen||future) && <div className={`future-popover panel ${future?'is-future':''}`}>
      <div><strong>未来温度</strong><span>FDS预计算结果</span></div>
      <p>当前 {s.currentTimeS.toFixed(1)} s {future?`→ 目标 ${effectiveTime(s).toFixed(1)} s`:''}</p>
      {future && <p className="point-comparison">监测点：FDS {futurePointRaw?.toFixed(1)??'—'} ℃ · 点修正 {futurePointCorrected?.toFixed(1)??'—'} ℃<br/>当前 MOCK {currentPoint.sensorC?.toFixed(1)??'—'} ℃ · 冻结当前偏差，实验性推算</p>}
      <div className="future-options">{[10,30,60].map(d=><button key={d} className={`chip ${s.futureOffsetS===d?'is-active':''}`} disabled={!ready||s.currentTimeS+d>s.timeEndS} title={s.currentTimeS+d>s.timeEndS?'超出数据时间范围':`查看未来${d}秒`} onClick={()=>{s.setPlayback('PAUSED');s.setFutureOffset(d);s.setRenderMode('THERMAL_SLICE');}}>+{d}s</button>)}
      <button className="btn" onClick={()=>{s.setFutureOffset(null);setFutureOpen(false);}}>返回当前</button></div>
    </div>}
    <div className="playback-row">
      <button className="btn btn--primary play-button" disabled={!ready||future} onClick={()=>{if(s.playback==='ENDED'||s.currentTimeS>=s.timeEndS)s.setTime(0);s.setPlayback(s.playback==='PLAYING'?'PAUSED':'PLAYING');s.setRenderMode('THERMAL_SLICE');}}><svg className="play-icon" aria-hidden="true" viewBox="0 0 24 24">{s.playback==='PLAYING'?<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>:<path d="M7 3v18l16-9z"/>}</svg><span className="play-label">{s.playback==='PLAYING'?'Ⅱ 暂停':s.playback==='ENDED'||s.currentTimeS>=s.timeEndS?'↻ 重播':'▶ 播放'}</span></button>
      <button className="time-display time-jump" disabled={!ready||future} title="跳转指定时刻" aria-expanded={jumpOpen} onClick={()=>setJumpOpen(!jumpOpen)}>{formatClock(s.currentTimeS)}</button>
      <button className="btn future-open" disabled={!ready||future} aria-expanded={futureOpen} title="查看未来预计算温度" onClick={()=>setFutureOpen(!futureOpen)}>未来温度</button>
      <input type="range" aria-label="仿真时刻" min="0" max={fullTimeline||s.currentTimeS>60?s.timeEndS:60} step="0.1" value={s.currentTimeS} disabled={!ready||future} onChange={e=>{s.setTime(Number(e.target.value));s.setPlayback('PAUSED');s.setRenderMode('THERMAL_SLICE');}}/>
      <button className="time-end btn timeline-span" onClick={()=>setFullTimeline(!fullTimeline)}>{fullTimeline||s.currentTimeS>60?`完整${Math.round(s.timeEndS/60)}分钟`:'前60秒'}</button>
      <select aria-label="播放速度" value={s.playbackRate} onChange={e=>s.setPlaybackRate(Number(e.target.value))}>{[0.25,0.5,1,2,4].map(r=><option key={r} value={r}>{r}×</option>)}</select>
    </div>
    {jumpOpen && <label className="jump-field">跳转时刻（秒）<input type="number" aria-label="跳转时刻（秒）" min="0" max={fullTimeline||s.currentTimeS>60?s.timeEndS:60} step="0.1" value={s.currentTimeS} disabled={!ready||future} onChange={e=>{s.setTime(Number(e.target.value));s.setPlayback('PAUSED');s.setRenderMode('THERMAL_SLICE');}}/></label>}
    <div className="playback-caption"><span title="真实FDS预计算结果；传感器读数为MOCK，单点修正不改变原始空间场。">{s.sceneSwitching?'正在切换场景':automatic.phase==='MONITORING'?`模拟监测 ${automatic.mockC.toFixed(1)} ℃`:`${s.selectedCabinetId}${s.selectedCabinetId?.startsWith('HV')?` / ${s.selectedPowerMW}MW`:''}${future?' · 未来':''}`}</span><span>{s.showSlices&&frameTime!==null?`温度场采样 ${frameTime.toFixed(1)} s`:automatic.phase==='MONITORING'?'正在自动监测 · MOCK 演示':'原始 FDS 温度场 · 单点修正不影响色标'}</span></div>
  </div>;
}

export function CompactLegend({min,max}: {min:number;max:number;bottomClipped:boolean;topClipped:boolean}) {
  return <aside className="compact-legend panel" aria-label="温度色标">
    <div><strong>温度分布</strong><span>℃</span></div>
    <div className="compact-legend__ramp" role="img" aria-label={`温度色标 ${min}至${max}℃，颜色不代表燃烧状态`} style={{background:temperatureGradientCss('to right',visualization.palette,min,max)}}/>
    <div><span>{min}</span><span>{Math.round((min+max)/2)}</span><span>{max}</span></div>
  </aside>;
}
