import {useEffect,useMemo,useState} from 'react';
import {RenderMetricsOutput} from '../scene/DisasterVolumes';
import SceneRoot from '../scene/SceneRoot';
import {useFireStore,effectiveTime} from '../store/useFireStore';
import AutomaticFire,{useAutomaticFire,monitorSnapshot,MatchingDiagnostics,injectMockAnomaly} from '../simulation/AutomaticFire';
import {SimpleTimeline,CompactLegend} from '../ui/SimpleControls';
import BottomDock from '../ui/BottomDock';
import PredictionNotice from '../ui/PredictionNotice';
import SimulationSetup from '../ui/SimulationSetup';
import {service} from '../simulation/sensorService';
import type {DemoSettings,SetupOptions} from '../config/demoSettings';
import {findSliceFrameIndex} from '../data/scenarioProvider';
import {ThermalViewLoader,useThermalView} from '../data/thermalView';
import {FieldsV7Loader,useFieldsV7,nearestFieldFrame} from '../data/fieldsV7';
import {heatExtent} from '../utils/heatPresentation';
import {controlledGeometry,geometryStateKey} from '../data/sceneRegistry';
import {THERMAL_MIN_C,THERMAL_MAX_C} from '../data/palettes/thermal';
export {DEFAULT_THRESHOLDS} from '../store/useFireStore';
export default function App(){
 const [options,setOptions]=useState<SetupOptions|null>(null),[draft,setDraft]=useState<DemoSettings|null>(null),[running,setRunning]=useState<DemoSettings|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();setError('');void service<SetupOptions>('setup',undefined,controller.signal).then(o=>{setOptions(o);setDraft(d=>d??o.settings);}).catch(e=>{if(!controller.signal.aborted)setError(String(e));});return()=>controller.abort();},[retry]);
 function start(settings:DemoSettings){
  const s=useFireStore.getState();s.setPlayback('PAUSED');void s.selectCabinet(null);
  useFireStore.setState({loading:true,futureOffsetS:null,currentTimeS:0});
  setDraft(settings);setRunning(settings);
 }
 function settings(){const s=useFireStore.getState();s.setPlayback('PAUSED');void s.selectCabinet(null);setRunning(null);}
 if(running)return <FireViewer settings={running} onSettings={settings}/>;
 if(error)return <div className="boot-screen" role="alert">设置加载失败：{error}<button onClick={()=>setRetry(r=>r+1)}>重新加载</button></div>;
 if(!options||!draft)return <div className="boot-screen" role="status">正在加载演示设置…</div>;
 return <SimulationSetup options={options} initial={draft} onStart={start}/>;
}
export function FireViewer({settings,onSettings}:{settings:DemoSettings;onSettings:()=>void}){
  const s=useFireStore(),a=useAutomaticFire();
  const view=useThermalView(),fields=useFieldsV7();
  const [topView,setTopView]=useState(false);
  const [injecting,setInjecting]=useState(false),[injectionError,setInjectionError]=useState('');
  const [showTemperature,setShowTemperature]=useState(true),[showSmoke,setShowSmoke]=useState(true),[volume,setVolume]=useState(true),[thermalStatus,setThermalStatus]=useState('正在加载三维温度');
  useEffect(()=>{void useFireStore.getState().init();},[]);
  useEffect(()=>{useAutomaticFire.setState({manualMockC:null});},[s.sceneMode,s.sceneRevision]);
  const levels=useMemo(()=>Object.fromEntries(s.cabinets.map(c=>[c.id,c.id===s.selectedCabinetId&&a.phase==='FIRE'?'FIRE_ALARM':'UNKNOWN'] as const)),[s.cabinets,s.selectedCabinetId,a.phase]);
  const full=view.scenarioId===s.activeScenarioId&&view.slices.length>0;
  const multi=full&&fields.scenarioId===s.activeScenarioId&&fields.slices.length>0;
  const slices=useMemo(()=>multi?[...view.slices,...fields.slices]:full?view.slices:s.slices,[multi,full,view.slices,fields.slices,s.slices]);
  const data=useMemo(()=>multi?{...view.data,...fields.data}:full?view.data:s.sliceData,[multi,full,view.data,fields.data,s.sliceData]);
  const smokeFrame=fields.manifest?.scenarioId===s.activeScenarioId?nearestFieldFrame(fields.manifest.volumes[0]?.frames??[],effectiveTime(s)):null;
  const domain=slices[0]?{minC:THERMAL_MIN_C,maxC:THERMAL_MAX_C}:null;
  const geometryKey=s.scene?geometryStateKey(s.scene,effectiveTime(s)):'';
  const geometry=useMemo(()=>s.scene?controlledGeometry(s.scene,effectiveTime(s)):null,[s.scene,geometryKey]);
  const hrrIndex=s.hrr?.timesS.reduce((best,t,i,arr)=>Math.abs(t-effectiveTime(s))<Math.abs(arr[best]-effectiveTime(s))?i:best,0)??0;
  const releaseActive=!!s.hrr&&s.hrr.hrrKW[hrrIndex]>0;
  const sessionReady=!s.sceneSwitching&&a.sceneMode===s.sceneMode;
  const hasLocatedFire=sessionReady&&a.fireOriginAbsoluteS!==null;
  const predictionText=a.predictionNotice?.startsWith('已匹配FDS阶段')?'后续预测已更新':a.predictionNotice?.replace('预计算场可能不连续。','');
  const matchingInjection=!!a.snapshot?.mockInjected&&!!(a.snapshot.pending||a.predictionNotice?.startsWith('梁下传感器温度与预测值偏差'));
  const noticeText=matchingInjection&&a.snapshot?.injectedDeltaC!=null?`梁下传感器温度与预测值偏差 +${a.snapshot.injectedDeltaC.toFixed(1)}℃`:predictionText;
  const origin=s.cabinets.find(c=>c.id===s.selectedCabinetId)?.burnerCenterFdsM;
  const heatFrameKey=slices.map(sl=>findSliceFrameIndex(sl,effectiveTime(s))?.index??-1).join(',');
  const heat=useMemo(()=>heatExtent(slices,data,effectiveTime(s),origin),[slices,data,heatFrameKey,origin]);
  const point=monitorSnapshot(s.currentTimeS);
  if(s.loading)return <div className="boot-screen" role="status">正在加载116配电室…</div>;
  if(s.loadError||!s.scene)return <div className="boot-screen" role="alert">房间数据加载失败：{s.loadError}<button onClick={()=>void s.init()}>重新加载</button></div>;
  return <div className={`app-shell automatic-shell ${a.phase==='MONITORING'?'is-monitoring':''}`}>
    {!s.sceneSwitching&&<AutomaticFire settings={settings}/>}
    <ThermalViewLoader/>
    <FieldsV7Loader/>
    <RenderMetricsOutput/>
    <MatchingDiagnostics/>
    <output id="scene-diagnostics" hidden>{JSON.stringify({mode:s.sceneMode,revision:s.sceneRevision,visible:!s.sceneSwitching,scenario:s.activeScenarioId,geometryScenario:s.scene.scenarioId,geometrySource:s.scene.generatedFrom.masterFile,solids:geometry?.solids.length,surfaces:geometry?.surfaces.length,thermalScenario:view.scenarioId,fieldScenario:fields.manifest?.scenarioId,timeS:s.currentTimeS,effectiveTimeS:effectiveTime(s),endS:s.timeEndS,hrrSampleTimeS:s.hrr?.timesS[hrrIndex],hrrKW:s.hrr?.hrrKW[hrrIndex],releaseActive})}</output>
    <SceneRoot beamSensorPoint={sessionReady&&a.snapshot?.mockInjected?a.snapshot.beam.position:null} monitoring={a.phase==='MONITORING'} scene={geometry!} sceneVisible={!s.sceneSwitching&&!s.loadError} releaseActive={releaseActive&&sessionReady} cabinets={s.cabinets} selectedCabinetId={sessionReady&&a.phase==='FIRE'?s.selectedCabinetId:null}
      zoneFilter="ALL" wallOpacity={s.wallOpacity} showRoof={s.showRoof} showCabinetLabels={false}
      temperatureScenarioId={a.phase==='FIRE'||a.phase==='MATCHING'?s.activeScenarioId:null} onTemperatureAvailability={setThermalStatus} temperatureVisible={showTemperature&&a.phase==='FIRE'&&!a.switching} temperatureVolume={volume} showSmoke={showSmoke&&a.phase==='FIRE'&&!a.switching}
      showSlices={showTemperature&&!volume&&sessionReady&&s.showSlices&&a.phase==='FIRE'&&full&&!a.switching} slicePlane={s.slicePlane} slices={slices} sliceData={data} heatPeak={heat} heatTopView={topView} multiSlices={multi} disasterManifest={a.phase==='FIRE'&&!a.switching&&sessionReady&&fields.manifest?.scenarioId===s.activeScenarioId?fields.manifest:null} disasterData={fields.volumeData}
      volumeManifest={s.volumeManifest} volumeData={s.volumeData} volumeLoading={s.volumeLoading} showVolume={false}
      currentTimeS={s.currentTimeS} effectiveTimeS={effectiveTime(s)} alarmLevels={levels}
      fireAlarmLit={sessionReady&&a.phase==='FIRE'&&releaseActive&&s.currentTimeS<1&&s.futureOffsetS===null} onSelectCabinet={()=>{}}
      focusToken={a.phase==='FIRE'?1:0}/>
    <header className="auto-header"><div><h1>116配电室</h1><span>Fire Visualization</span></div>
      <div className="status-capsule">
        <div className={`auto-state ${a.phase==='FIRE'?'is-fire':''}`} role="status" title={`暂定梁下点；原始FDS ${point.rawFdsC?.toFixed(2)??'—'}℃ / ${a.snapshot?.beam.source??'MOCK'} ${point.sensorC?.toFixed(2)??'—'}℃ / 修正 ${point.correctedC?.toFixed(2)??'—'}℃；不修正三维场`}>
          <i className="status-dot" aria-hidden="true"/>
          <span>{s.sceneSwitching?'正在切换场景':!sessionReady||a.phase==='MONITORING'?'自动监测中':a.phase==='MATCHING'?'正在匹配火灾工况':a.phase==='ERROR'?'数据不可用':<>已定位 <b>{s.selectedCabinetId}</b> · <b>{s.futureOffsetS!==null?'查看未来温度':s.playback==='PLAYING'?'温度传播中':'已暂停'}</b></>}</span>
          {sessionReady&&a.phase==='MONITORING'&&<time className="monitoring-time" aria-label="已监测时长">{String(Math.floor(a.absoluteS/60)).padStart(2,'0')}:{String(Math.floor(a.absoluteS%60)).padStart(2,'0')}</time>}
        </div>
      </div><button className="main-settings-button" aria-label="设置" onClick={onSettings} title="设置"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 1-3-2-2 1-3-3-2-3 1-2-2Z"/><circle cx="12" cy="12" r="3"/></svg></button></header>
    <div className="view-tools panel"><button className="btn" onClick={s.toggleRoof}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 10 12 3l9 7M5 9v12h14V9M9 21v-8h6v8"/></svg>{s.showRoof?'打开屋顶':'合上屋顶'}</button><button className="btn" onClick={()=>s.setWallOpacity(s.wallOpacity<1?1:.22)}><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h1m6 0h1M8 16h1m6 0h1"/></svg>透明显示</button><button className="btn" aria-pressed={topView} onClick={()=>setTopView(!topView)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 15V5a3 3 0 0 1 6 0v10a5 5 0 1 1-6 0ZM12 7v10"/></svg>{topView?'建筑视角':'俯视热量'}</button></div>
    {hasLocatedFire&&<div className="field-controls panel"><button className="btn" aria-pressed={showTemperature} onClick={()=>setShowTemperature(!showTemperature)}>温度{showTemperature?'已显示':'已隐藏'}</button><button className="btn" aria-pressed={showSmoke} onClick={()=>setShowSmoke(!showSmoke)}>烟气{showSmoke?'已显示':'已隐藏'}</button><button className="btn" aria-pressed={volume} onClick={()=>setVolume(!volume)}>{volume?'三维温度':'温度截面'}</button><button className="btn" disabled={!a.snapshot?.anomalyAvailable||injecting||a.phase!=='FIRE'||s.playback!=='PLAYING'||!!a.switching||!!a.snapshot?.mockInjected||Math.abs(s.currentTimeS-(a.snapshot?.offsetS??0)-(a.snapshot?.actualS??0))>1.5} onClick={async()=>{setInjecting(true);setInjectionError('');try{await injectMockAnomaly();}catch(e){setInjectionError(String(e));}finally{setInjecting(false);}}}>温度升温</button></div>}
    {(s.datasetError||(sessionReady&&a.error)||injectionError)&&<div className="auto-error" role="alert">{s.datasetError||a.error||injectionError}</div>}
    {sessionReady&&a.phase==='FIRE'&&full&&!a.switching&&<div className="heat-summary panel" role="status"><strong title="真实FDS多方向温度截面；完整真实帧，无空间外推。">{s.futureOffsetS!==null?'未来':'当前'}热量分布</strong><span className="heat-reading">{heat.maxC===null?'温度加载中':<><em title={`真实温度切片最高值；${thermalStatus}；不是体场最大值`}>最高</em>{heat.maxC.toFixed(1)}<small>℃</small></>}</span><small>{heat.warmCount?`≥40℃区域距火源最远水平 ${heat.maxDistanceM.toFixed(1)}m`:'当前截面暂无≥40℃区域'}</small><small>{smokeFrame?`FDS烟气 / 局部热释放 · ${smokeFrame.timeS.toFixed(1)}s`:fields.loading?'正在加载烟气…':fields.error?'烟气数据未接入':''}</small></div>}
    {sessionReady&&noticeText&&<PredictionNotice text={noticeText} matching={matchingInjection}/>}
    {view.error&&<div className="auto-error" role="alert">{view.error}</div>}
    {showTemperature&&sessionReady&&a.phase==='FIRE'&&full&&!a.switching&&domain&&<CompactLegend min={domain.minC} max={domain.maxC} bottomClipped={slices.some(x=>x.dataMinC<domain.minC)} topClipped={slices.some(x=>x.dataMaxC>domain.maxC)}/>}
    {hasLocatedFire&&<BottomDock timeline={<SimpleTimeline/>}/>}
  </div>;
}

