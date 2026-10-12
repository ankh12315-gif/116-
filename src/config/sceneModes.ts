import {fireSimulation} from './fireSimulation';
export type SceneMode='windowed'|'windowless';
export const sceneModes={windowed:{label:'有窗',sourceNote:'既有FDS · 构件常驻',defaultId:'HV-01-70MW'},windowless:{label:'无窗',sourceNote:'新增FDS · 构件按真实时刻移除',defaultId:'WL-HV-01-40MW-B0'}} as const;
export function assertSceneId(mode:SceneMode,id:string){if((mode==='windowless')!==id.startsWith('WL-'))throw new Error('工况不属于当前场景，禁止跨场景替代');}
export function resultsBase(mode:SceneMode,id:string){assertSceneId(mode,id);return mode==='windowed'?`assets/results/${id}`:`assets/scenes/windowless/results/${id}`;}
export function fieldBase(mode:SceneMode,id:string,kind:'thermal'|'fields'){assertSceneId(mode,id);return mode==='windowed'?`/assets/${kind==='thermal'?'thermal-view-v4':'fields-v7'}/${id}/`:`/assets/scenes/windowless/${kind}/${id}/`;}
export function simulationForMode(mode:SceneMode){
 if(mode==='windowed')return fireSimulation;
 const cabinet=import.meta.env.VITE_WINDOWLESS_CABINET==='LV-01'?'LV-01':'HV-01';
 return {...fireSimulation,monitor:{id:'beam',fdsM:[11.5,-12,4.5] as [number,number,number],label:'新增FDS梁下气相点（独立覆盖审计，暂定）'},defaultCabinetId:cabinet,highPowerMW:40,mockObservationScenarioId:cabinet==='HV-01'?'WL-HV-01-40MW-B0':'WL-LV-01-FIRE-B0',mockAnomaly:{...fireSimulation.mockAnomaly,enabled:false},sourceUrl:'/assets/scenes/windowless/beam-curves.json'};
}
export function scenarioInScene(mode:SceneMode,cabinet:string,power:number){
 if(mode==='windowed')return cabinet.startsWith('HV')?`${cabinet}-${power}MW`:`${cabinet}-FIRE`;
 if(cabinet==='HV-01'&&power===40)return 'WL-HV-01-40MW-B0';
 if(cabinet==='LV-01')return 'WL-LV-01-FIRE-B0';
 throw new Error('当前无窗场景缺少该柜位/功率的FDS结果；禁止使用有窗结果');
}
