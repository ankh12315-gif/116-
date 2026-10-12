import {useState} from 'react';
import {settingsError,type DemoSettings,type SetupOptions} from '../config/demoSettings';
function SensorIcon(){return <svg aria-hidden="true" viewBox="0 0 32 32"><path d="M13 19V8a3 3 0 0 1 6 0v11a6 6 0 1 1-6 0Z"/><path d="M16 11v12m7-13 3-2m-3 6h4m-4 4 3 2"/></svg>;}
export default function SimulationSetup({options,initial,onStart}:{options:SetupOptions;initial:DemoSettings;onStart:(settings:DemoSettings)=>void}){
 const [draft,setDraft]=useState<DemoSettings>(()=>structuredClone(initial));
 const error=settingsError(draft,options),hot=options.cabinetIds.filter(id=>draft.temperaturesC[id]>=options.thresholdC);
 function card(id:string){const high=id.startsWith('HV'),alarming=draft.temperaturesC[id]>=options.thresholdC;
  return <article className={`sensor-setting-card ${alarming?'is-triggered':''}`} key={id}>
   <div className="sensor-setting-head"><span className="sensor-setting-icon"><SensorIcon/></span><div><h3>{id}</h3><span>{high?'高压柜':'低压柜'} · 传感器</span></div>{alarming&&<span className="setting-fire-tag">起火设定</span>}</div>
   <label className="sensor-temperature"><span>第{options.triggerAtS}秒温度</span><span className="temperature-input-wrap"><input type="number" aria-label={`${id}第${options.triggerAtS}秒温度`} min={-50} max={2000} step="0.1" value={Number.isFinite(draft.temperaturesC[id])?draft.temperaturesC[id]:''} onChange={e=>setDraft(d=>({...d,temperaturesC:{...d.temperaturesC,[id]:e.target.value===''?NaN:Number(e.target.value)}}))}/><span>℃</span></span></label>
   {high&&<div className="setting-power" role="group" aria-label={`${id}火源功率`}>{options.powers.map(p=><button key={p} type="button" aria-label={`${id} ${p}MW`} aria-pressed={draft.powerMWByCabinet[id]===p} onClick={()=>setDraft(d=>({...d,powerMWByCabinet:{...d.powerMWByCabinet,[id]:p}}))}>{p}<small> MW</small></button>)}</div>}
  </article>;
 }
 return <main className="simulation-setup">
  <div className="setup-inner">
   <header className="setup-header"><div className="setup-brand"><h1>温度调控</h1></div><span className="setup-threshold">起火阈值 <b>{options.thresholdC}℃</b></span></header>
   <form onSubmit={e=>{e.preventDefault();if(!error)onStart(structuredClone(draft));}}>
    <section className="setup-section"><h2>高压柜 <span>选择火源功率</span></h2><div className="setup-grid high">{options.cabinetIds.filter(id=>id.startsWith('HV')).map(card)}</div></section>
    <section className="setup-section"><h2>低压柜</h2><div className="setup-grid low">{options.cabinetIds.filter(id=>id.startsWith('LV')).map(card)}</div></section>
    <footer className="setup-footer"><div>{error?<p className="setup-validation" role="alert">{error}</p>:<><strong>{hot.length?`起火设定：${hot[0]}${hot[0].startsWith('HV')?` / ${draft.powerMWByCabinet[hot[0]]}MW`:''}`:'未设置起火柜体'}</strong><span>{hot.length?'确认后进入三维演示':'确认后进入自动监测'}</span></>}</div><button type="submit" disabled={!!error}>确定并开始 <span aria-hidden="true">→</span></button></footer>
   </form>
  </div>
 </main>;
}
