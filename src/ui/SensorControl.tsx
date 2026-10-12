import {useEffect,useState} from 'react';
import {useFireStore} from '../store/useFireStore';
import {monitorSnapshot,useAutomaticFire} from '../simulation/AutomaticFire';
import {simulationForMode} from '../config/sceneModes';
export default function SensorControl(){
 const [open,setOpen]=useState(false);
 const a=useAutomaticFire(),s=useFireStore(),point=monitorSnapshot(s.currentTimeS);
 const cfg=simulationForMode(s.sceneMode);
 useEffect(()=>{setOpen(false);},[s.sceneRevision]);
 return <div className="sensor-control"><button className="btn" aria-expanded={open} onClick={()=>setOpen(!open)}><svg className="sensor-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M9 15V5a3 3 0 0 1 6 0v10a5 5 0 1 1-6 0ZM12 7v10"/></svg>传感器温度</button>
 {open&&<div className="sensor-popover panel" aria-label="设置模拟传感器温度">
  <strong>{a.snapshot?.beam.source==='SENSOR'?'接口传感器 · SENSOR':'模拟传感器 · MOCK'}</strong>
  <p>{a.manualMockC===null?'自动读数':`手动恒定读数 ${a.manualMockC.toFixed(1)}℃`}</p>
  {a.phase==='MONITORING'?<p>达到{a.snapshot?.config?.thresholdC??cfg.triggerThresholdC}℃并持续{a.snapshot?.config?.holdS??cfg.triggerHoldS}秒触发演示</p>:<p>同点FDS {point.rawFdsC?.toFixed(1)??'—'}℃ · {a.snapshot?.beam.source??'MOCK'} {point.sensorC?.toFixed(1)??'—'}℃<br/>点修正 {point.correctedC?.toFixed(1)??'—'}℃（偏差限幅±{cfg.correctionMaxDeltaC}℃）</p>}
  {a.snapshot&&<p>采样实际起火后 {(a.snapshot.beam.sampleActualS??a.snapshot.actualS).toFixed(1)}s · 对应FDS {(a.snapshot.beam.sampleFdsS??a.snapshot.displayFdsS).toFixed(1)}s</p>}
  {a.sessionId&&<a href={`/sensors.html?session=${encodeURIComponent(a.sessionId)}`} target="_blank" rel="noreferrer">查看全部传感器与接口</a>}
 </div>}</div>;
}
