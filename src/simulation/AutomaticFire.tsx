import {useEffect} from 'react';
import {create} from 'zustand';
import {useFireStore} from '../store/useFireStore';
import {pointTemperature} from './monitorCorrection';
import type {PointCurve,SensorReading} from './monitorCorrection';
import {waitForPresentation} from '../data/presentationReady';
import {service,type ServiceSnapshot} from './sensorService';
import {waitForTemperature} from '../scene/TemperatureField';
import type {SceneMode} from '../config/sceneModes';
import type {DemoSettings} from '../config/demoSettings';
interface AutomaticState {sceneMode:SceneMode;phase:'MONITORING'|'MATCHING'|'FIRE'|'ERROR';absoluteS:number;fireOriginAbsoluteS:number|null;mockC:number;manualMockC:number|null;curves:Record<string,PointCurve>;error:string|null;predictionNotice?:string;switching?:boolean;sessionId:string|null;snapshot:ServiceSnapshot|null;}
export const useAutomaticFire=create<AutomaticState>(()=>({sceneMode:'windowed',phase:'MONITORING',absoluteS:0,fireOriginAbsoluteS:null,mockC:20,manualMockC:null,curves:{},error:null,sessionId:null,snapshot:null}));
// Compatibility adapter: manual constant reads no longer drive the runtime. Use the typed backend API.
export function setMockTemperature(value:number|null):boolean {if(value!==null&&(!Number.isFinite(value)||value< -50||value>2000))return false;useAutomaticFire.setState({manualMockC:value});return true;}
export async function injectMockAnomaly(){
 const id=useAutomaticFire.getState().sessionId;if(!id)throw Error('监测服务未就绪');
 const snap=await service<ServiceSnapshot&{deltaC:number}>('anomaly',{session:id});
 if(useAutomaticFire.getState().sessionId===id)useAutomaticFire.setState({snapshot:snap,predictionNotice:snap.notice});
 return {deltaC:snap.deltaC};
}
export function monitorSnapshot(fdsS:number){
 const a=useAutomaticFire.getState(),s=useFireStore.getState(),b=a.snapshot?.beam;
 // Compare sampled sensor and FDS at the same acquisition instant, not the later RAF time.
 const raw=a.snapshot?.scenarioId===s.activeScenarioId&&fdsS===s.currentTimeS?b?.rawFdsC??null:pointTemperature(a.curves[s.activeScenarioId??''],fdsS),sensorC=a.manualMockC??b?.valueC??null,deltaT=sensorC!==null&&raw!==null?sensorC-raw:null;
 const absoluteS=a.absoluteS,appliedDeltaC=deltaT===null?0:Math.max(-20,Math.min(20,deltaT));
 const reading:SensorReading|null=sensorC===null?null:{source:b?.source??'MOCK',absoluteS,valueC:sensorC,monitorId:'beam',scenarioId:s.activeScenarioId??''};
 return {absoluteS,reading,rawFdsC:raw,sensorC,deltaT,appliedDeltaC,correctedC:raw===null?null:raw+appliedDeltaC,errorBeforeC:deltaT===null?null:Math.abs(deltaT),errorAfterC:deltaT===null?null:Math.abs(deltaT-appliedDeltaC),applied:deltaT!==null};
}
export function MatchingDiagnostics(){const a=useAutomaticFire();return <output id="matching-diagnostics" hidden>{JSON.stringify(a.snapshot)}</output>;}
export const sceneSimulationLogs:Record<SceneMode,unknown[]>={windowed:[],windowless:[]};
export default function AutomaticFire({settings}:{settings?:DemoSettings}){
 const loading=useFireStore(s=>s.loading);
 useEffect(()=>{
  if(loading)return;let live=true,timer:ReturnType<typeof setTimeout>,session='',origin:number|null=null,offset=0,activated=false,lastAbsolute=0;
  const controller=new AbortController(),started=performance.now();
  useAutomaticFire.setState({phase:'MONITORING',sceneMode:'windowed',error:null,snapshot:null,sessionId:null,fireOriginAbsoluteS:null,absoluteS:0,mockC:20,manualMockC:null,predictionNotice:undefined,switching:false,curves:{}});
  const fail=(e:unknown)=>{if(live){useAutomaticFire.setState({phase:'ERROR',error:String(e),switching:false});useFireStore.getState().setPlayback('PAUSED');}};
  async function tick(){
   if(!live)return;
   try{
    const s=useFireStore.getState();const actual=Math.max(0,s.currentTimeS-offset);
    // Explicit simulation clock: speed affects MOCK acquisition; scrubbing never rewrites observation time.
    const absolute=origin===null?(performance.now()-started)/1000:origin+actual;
    lastAbsolute=Math.max(lastAbsolute,absolute);
    const snap=await service<ServiceSnapshot>('step',{session,absoluteS:lastAbsolute,actualS:actual,playing:activated&&s.playback==='PLAYING'&&s.futureOffsetS===null},controller.signal);
    if(!live)return;
    useAutomaticFire.setState({snapshot:snap,absoluteS:snap.absoluteS,mockC:snap.cabinetSensors.find(x=>x.id===snap.cabinetId)?.valueC??20,fireOriginAbsoluteS:snap.origin,predictionNotice:snap.notice||undefined});
    if(snap.phase==='FIRE'&&!activated){
     origin=snap.origin;useAutomaticFire.setState({phase:'MATCHING'});
     useFireStore.setState({selectedPowerMW:snap.scenarioId.includes('MW')?Number(snap.scenarioId.split('-').slice(-1)[0]?.replace('MW','')):null});
     await s.selectCabinet(snap.cabinetId);await waitForPresentation(snap.scenarioId);await waitForTemperature(snap.scenarioId);if(!live)return;
     if(useFireStore.getState().activeScenarioId!==snap.scenarioId)throw Error('初始工况与服务端不一致');
     activated=true;const next=useFireStore.getState();next.setTime(0);next.setRenderMode('THERMAL_SLICE');next.setPlaybackRate(.5);next.setPlayback('PLAYING');useAutomaticFire.setState({phase:'FIRE'});
    }
    if(snap.pending){
     const p=snap.pending,playback=s.playback,at=actual;useAutomaticFire.setState({switching:true});s.setPlayback('PAUSED');
     try{
      if(p.scenarioId!==s.activeScenarioId){useFireStore.setState({selectedPowerMW:Number(p.scenarioId.split('-').slice(-1)[0]?.replace('MW',''))});await s.activateScenario(p.scenarioId);await waitForPresentation(p.scenarioId);await waitForTemperature(p.scenarioId);}
      if(!live)return;
      await service('ack',{session,token:p.token,success:true},controller.signal);offset=p.offsetS;
      const next=useFireStore.getState();next.setTime(at+offset);next.setPlayback(playback);useAutomaticFire.setState({switching:false});
     }catch(e){
      await service('ack',{session,token:p.token,success:false}).catch(()=>{});
      if(live&&p.scenarioId!==s.activeScenarioId&&s.activeScenarioId){
       useFireStore.setState({selectedPowerMW:s.selectedPowerMW});await useFireStore.getState().activateScenario(s.activeScenarioId);
       await waitForPresentation(s.activeScenarioId);await waitForTemperature(s.activeScenarioId);useFireStore.getState().setTime(at+offset);
      }
      throw e;
     }
    }
    timer=setTimeout(tick,250);
   }catch(e){if(!controller.signal.aborted)fail(e);}
  }
  void(async()=>{try{
   const [snap,curves]=await Promise.all([service<ServiceSnapshot&{id:string}>('session',{settings},controller.signal).then(snap=>{session=snap.id;if(!live)void service('end',{session}).catch(()=>{});return snap;}),fetch('/assets/monitor-v3/beam-curves.json',{signal:controller.signal}).then(r=>{if(!r.ok)throw Error('梁下曲线缺失');return r.json();})]);
   if(!live)return;session=snap.id;useAutomaticFire.setState({sessionId:session,snapshot:snap,curves});await tick();
  }catch(e){if(!controller.signal.aborted)fail(e);}})();
  return()=>{live=false;controller.abort();clearTimeout(timer);if(session)void service('end',{session}).catch(()=>{});};
 },[loading,settings]);
 return null;
}
