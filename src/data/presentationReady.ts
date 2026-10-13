import {useFireStore} from '../store/useFireStore';
import {useThermalView} from './thermalView';
import {useFieldsV7} from './fieldsV7';
/** Loading does not advance physical time or show a previous case's fields. */
export function waitForPresentation(id:string):Promise<void>{
 return new Promise((resolve,reject)=>{let done=false;let subscriptions:(()=>void)[]=[];
 const timer=setTimeout(()=>finish(new Error('完整温度/烟气数据加载超时')),Number((import.meta as unknown as {env?:Record<string,string>}).env?.VITE_PRESENTATION_TIMEOUT_MS)||180000);
 function finish(error?:Error){if(done)return;done=true;clearTimeout(timer);subscriptions.forEach(fn=>fn());error?reject(error):resolve();}
 function check(){
  const s=useFireStore.getState(),t=useThermalView.getState(),f=useFieldsV7.getState();
  const okActive=s.activeScenarioId===id,okThermal=t.scenarioId===id&&t.slices.length>0,okFields=f.scenarioId===id&&!f.loading&&(f.manifest!==null||f.error!==null);
  if(!okActive)return finish(new Error('工况请求已改变'));
  if(t.error)return finish(new Error(t.error));
  if(okThermal&&okFields)finish();
 }
 subscriptions=[useFireStore.subscribe(check),useThermalView.subscribe(check),useFieldsV7.subscribe(check)];check();
 });
}