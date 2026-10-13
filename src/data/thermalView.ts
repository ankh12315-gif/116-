import {create} from 'zustand';
import {useEffect} from 'react';
import {useFireStore} from '../store/useFireStore';
import {validateDatasetQuantization} from './scenarioProvider';
import type {SliceMeta,ScenarioDataset} from '../types/domain';
import {fieldBase} from '../config/sceneModes';
export const useThermalView=create<{scenarioId:string|null;slices:SliceMeta[];data:Record<string,Float32Array>;error:string|null}>(()=>({scenarioId:null,slices:[],data:{},error:null}));
// __fetchRetry: 公网(4Mbps)链路下大二进制切片偶发 ERR_CONTENT_LENGTH_MISMATCH/TCP 中断，
// 对可恢复的网络类错误做有限次重试（3 次，退避 500/1500/3000ms）。
// 仅重试网络层错误；HTTP 4xx/5xx 与数据校验失败不重试（属于真实故障）。
async function __fetchRetry(url:string,signal:AbortSignal,label:string):Promise<Response>{
 const delays=[500,1500,3000];
 let lastErr:unknown=null;
 for(let attempt=0;attempt<=delays.length;attempt++){
  if(signal.aborted)throw new DOMException('Aborted','AbortError');
  try{
   const r=await fetch(url,{signal});
   if(!r.ok)throw new Error('HTTP '+r.status+' '+label);
   return r;
  }catch(e){
   lastErr=e;
   if((e as Error)?.name==='AbortError')throw e;
   const msg=String((e as Error)?.message??e);
   // 只对网络层/传输层错误重试；HTTP 状态错误直接抛出
   if(/^HTTP \d+/.test(msg))throw e;
   if(attempt<delays.length){
    await new Promise(res=>setTimeout(res,delays[attempt]));
   }
  }
 }
 throw lastErr instanceof Error?lastErr:new Error(String(lastErr));
}

export function ThermalViewLoader(){
 const id=useFireStore(s=>s.activeScenarioId);
 const mode=useFireStore(s=>s.sceneMode),revision=useFireStore(s=>s.sceneRevision);
 useEffect(()=>{const controller=new AbortController();useThermalView.setState({scenarioId:null,slices:[],data:{},error:null});if(!id)return;
  const base=fieldBase(mode,id,'thermal');
  void (async()=>{try{
   const response=await fetch(base+'manifest.json',{signal:controller.signal});if(!response.ok)throw new Error('当前场景完整温度帧未接入，禁止跨场景替代');
   const manifest=await response.json() as ScenarioDataset;validateDatasetQuantization(manifest,id);
   if((manifest as ScenarioDataset&{storageEncoding?:string}).storageEncoding!=='FLOAT32_LE')throw new Error('完整帧温度编码错误');
   const data:Record<string,Float32Array>={};if(mode==='windowless'&&(manifest as ScenarioDataset&{sceneMode?:string}).sceneMode!==mode)throw new Error('温度清单场景不符');
   /* __serialPolyfill: 串行下载(非并发)，避免 4Mbps 链路多文件并发中断；语义不变：全部到齐才 setState */ await (async()=>{for(const sl of manifest.slices){const r=await __fetchRetry(base+sl.asset,controller.signal,'完整帧温度数据缺失');const buffer=await r.arrayBuffer();if(buffer.byteLength!==sl.ni*sl.nj*sl.frameCount*4)throw new Error('完整帧温度长度错误');const b=new Float32Array(buffer);const step=Math.max(1,Math.floor(b.length/4096));for(let i=0;i<b.length;i+=step){if(!Number.isFinite(b[i]))throw new Error('完整帧存在无效温度');}data[sl.asset]=b;}})();
   if(!controller.signal.aborted&&useFireStore.getState().sceneRevision===revision)useThermalView.setState({scenarioId:id,slices:manifest.slices,data,error:null});
  }catch(e){if(!controller.signal.aborted&&useFireStore.getState().sceneRevision===revision)useThermalView.setState({error:String(e)});}})();
  return()=>controller.abort();
 },[id,mode,revision]);return null;
}
