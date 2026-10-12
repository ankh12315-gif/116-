import {create} from 'zustand';
import {useEffect} from 'react';
import {useFireStore} from '../store/useFireStore';
import {validateDatasetQuantization} from './scenarioProvider';
import type {SliceMeta,ScenarioDataset} from '../types/domain';
import {fieldBase} from '../config/sceneModes';
export const useThermalView=create<{scenarioId:string|null;slices:SliceMeta[];data:Record<string,Float32Array>;error:string|null}>(()=>({scenarioId:null,slices:[],data:{},error:null}));
export function ThermalViewLoader(){
 const id=useFireStore(s=>s.activeScenarioId);
 const mode=useFireStore(s=>s.sceneMode),revision=useFireStore(s=>s.sceneRevision);
 useEffect(()=>{const controller=new AbortController();useThermalView.setState({scenarioId:null,slices:[],data:{},error:null});if(!id)return;
  const base=fieldBase(mode,id,'thermal');
  void (async()=>{try{
   const response=await fetch(base+'manifest.json',{signal:controller.signal});if(!response.ok)throw new Error('当前场景完整温度帧未接入，禁止跨场景替代');
   const manifest=await response.json() as ScenarioDataset;validateDatasetQuantization(manifest,id);
   if((manifest as ScenarioDataset&{storageEncoding?:string}).storageEncoding!=='FLOAT32_LE')throw new Error('完整帧温度编码错误');
   const data:Record<string,Float32Array>={};
   if(mode==='windowless'&&(manifest as ScenarioDataset&{sceneMode?:string}).sceneMode!==mode)throw new Error('温度清单场景不符');
   await Promise.all(manifest.slices.map(async sl=>{const r=await fetch(base+sl.asset,{signal:controller.signal});if(!r.ok)throw new Error('完整帧温度数据缺失');const buffer=await r.arrayBuffer();if(buffer.byteLength!==sl.ni*sl.nj*sl.frameCount*4)throw new Error('完整帧温度长度错误');const b=new Float32Array(buffer);if(b.some(v=>!Number.isFinite(v)))throw new Error('完整帧存在无效温度');data[sl.asset]=b;}));
   if(!controller.signal.aborted&&useFireStore.getState().sceneRevision===revision)useThermalView.setState({scenarioId:id,slices:manifest.slices,data,error:null});
  }catch(e){if(!controller.signal.aborted&&useFireStore.getState().sceneRevision===revision)useThermalView.setState({error:String(e)});}})();
  return()=>controller.abort();
 },[id,mode,revision]);return null;
}
