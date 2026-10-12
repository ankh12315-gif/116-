import {pointTemperature,type PointCurve} from './monitorCorrection';

export interface MockProfile {
 enabled:boolean;atFdsS:number;targetScenarioId:string;
 profile:'step'|'ramp'|'spike';transitionS:number;spikeDurationS:number;
}
/** Test-fixture target is private to the source; matcher only receives measured values. */
export function mockObservationTemperature(curves:Record<string,PointCurve>,initialId:string,t:number,biasC:number,cfg:MockProfile):number|null {
 const initial=curves[initialId],base=pointTemperature(initial,t);
 if(base===null)return null;
 if(!cfg.enabled||t<cfg.atFdsS)return base+biasC;
 const target=curves[cfg.targetScenarioId];
 // Missing/incompatible fixture is unavailable, never replaced by another scene.
 if(!target||!initial||target.sceneMode!==initial.sceneMode||target.cabinetId!==initial.cabinetId||target.openingAtS!==initial.openingAtS||target.sampledFdsM.length!==3||initial.sampledFdsM.length!==3||target.sampledFdsM.some((x,i)=>x!==initial.sampledFdsM[i]))return null;
 const value=pointTemperature(target,t);if(value===null)return null;
 if(cfg.profile==='spike')return t<cfg.atFdsS+cfg.spikeDurationS?value+biasC:base+biasC;
 const weight=cfg.profile==='step'?1:Math.min(1,Math.max(0,(t-cfg.atFdsS)/Math.max(cfg.transitionS,.001)));
 return (base+biasC)*(1-weight)+(value+biasC)*weight;
}
