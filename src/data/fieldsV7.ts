import {create} from 'zustand';
import {useEffect} from 'react';
import {useFireStore} from '../store/useFireStore';
import type {SliceMeta} from '../types/domain';
import {validateDatasetQuantization} from './scenarioProvider';
import {fieldBase} from '../config/sceneModes';
export interface RleFrame {timeS:number;offset:number;length:number;maxByte:number}
export interface FieldVolume {asset:string;meshIndex:number;meshXb:number[];ni:number;nj:number;nk:number;quantity:'SOOT DENSITY'|'HRRPUV';storageEncoding:string;dxM:number;hrrClipKWPerM3:number;frames:RleFrame[]}
export interface FieldManifest {scenarioId:string;slices:SliceMeta[];volumes:FieldVolume[]}
export function nearestFieldFrame(frames:RleFrame[],t:number):RleFrame|null{
 if(!Number.isFinite(t)||!frames.length||t<frames[0].timeS||t>frames[frames.length-1].timeS)return null;
 let lo=0,hi=frames.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(frames[mid].timeS<=t)lo=mid;else hi=mid;}return t-frames[lo].timeS<=frames[hi].timeS-t?frames[lo]:frames[hi];
}
export function decodeRleFrame(buffer:Uint8Array,frame:RleFrame,expected:number):Uint8Array{
 if(frame.offset<0||frame.offset+frame.length>buffer.length)throw new Error('烟气帧越界');const out=new Uint8Array(expected);let dst=0;
 for(let i=frame.offset;i<frame.offset+frame.length;i++){const b=buffer[i];if(b===255){if(i+2>=frame.offset+frame.length)throw new Error('RLE尾部错误');const value=buffer[++i],count=buffer[++i];if(dst+count>expected)throw new Error('RLE超长');out.fill(value,dst,dst+count);dst+=count;}else{if(dst>=expected)throw new Error('RLE超长');out[dst++]=b;}}
 if(dst!==expected)throw new Error('RLE长度错误');return out;
}
export function opticalDepth(q:number,dxM:number):number{return q===0?0:-Math.log(Math.max(1-q/254,1/254))/dxM;}
export const useFieldsV7=create<{scenarioId:string|null;manifest:FieldManifest|null;slices:SliceMeta[];data:Record<string,Float32Array>;volumeData:Record<string,Uint8Array>;error:string|null;loading:boolean}>(()=>({scenarioId:null,manifest:null,slices:[],data:{},volumeData:{},error:null,loading:false}));
export function FieldsV7Loader(){
 const id=useFireStore(s=>s.activeScenarioId);
 const mode=useFireStore(s=>s.sceneMode),revision=useFireStore(s=>s.sceneRevision);
 useEffect(()=>{const controller=new AbortController();useFieldsV7.setState({scenarioId:id,manifest:null,slices:[],data:{},volumeData:{},error:null,loading:!!id});if(!id)return;
 const base=fieldBase(mode,id,'fields');void(async()=>{try{
 const r=await fetch(base+'manifest.json',{signal:controller.signal});if(!r.ok)throw new Error('烟气数据未接入');const m=await r.json();validateDatasetQuantization(m,id);
 if(mode==='windowless'&&m.sceneMode!==mode)throw new Error('烟气/局部热释放清单场景不符');
 const data:Record<string,Float32Array>={},volumeData:Record<string,Uint8Array>={};
 await Promise.all(m.slices.map(async(s:SliceMeta)=>{const r=await fetch(base+s.asset,{signal:controller.signal});if(!r.ok)throw new Error('多方向温度数据缺失');const b=await r.arrayBuffer();if(b.byteLength!==s.ni*s.nj*s.frameCount*4)throw new Error('多截面长度错误');data[s.asset]=new Float32Array(b);}));
 await Promise.all(m.volumes.map(async(v:FieldVolume)=>{if(!['FDS676_RLE_OPACITY_254','FDS676_RLE_HRRPUV_254'].includes(v.storageEncoding))throw new Error('未验证的烟气编码');const r=await fetch(base+v.asset,{signal:controller.signal});if(!r.ok)throw new Error('烟气数据缺失');const b=new Uint8Array(await r.arrayBuffer());decodeRleFrame(b,v.frames[0],v.ni*v.nj*v.nk);volumeData[v.asset]=b;}));
 if(!controller.signal.aborted&&useFireStore.getState().sceneRevision===revision)useFieldsV7.setState({scenarioId:id,manifest:m,slices:m.slices,data,volumeData,loading:false});
 }catch(e){if(!controller.signal.aborted&&useFireStore.getState().sceneRevision===revision)useFieldsV7.setState({error:String(e),loading:false});}})();return()=>controller.abort();},[id,mode,revision]);return null;
}
