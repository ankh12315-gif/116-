export interface ServiceSnapshot {
 phase:'MONITORING'|'FIRE';absoluteS:number;origin:number|null;actualS:number;displayFdsS:number;offsetS:number;scenarioId:string;cabinetId:string;
 cabinetSensors:{id:string;valueC:number|null;source:string;position:number[]|null;alarm:boolean}[];
 beam:{position?:[number,number,number];valueC:number|null;rawFdsC:number|null;correctedC:number|null;deltaC:number|null;source:'MOCK'|'SENSOR';sampleActualS?:number|null;sampleFdsS?:number|null};
 config?:{thresholdC:number;holdS:number};
 injectedDeltaC?:number|null;
 pending:null|{token:string;kind:'STAGE'|'SCENARIO';scenarioId:string;offsetS:number;atActualS:number};mockInjected?:boolean;anomalyAvailable?:boolean;anomalyAtS?:number|null;notice:string;events:unknown[];
}
export async function service<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
 const b=await r.json().catch(()=>({error:'传感器服务未启动，请使用配套启动程序'}));if(!r.ok)throw Error(b.error??'传感器服务异常');return b;
}
