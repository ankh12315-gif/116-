import {useEffect,useMemo,useState} from 'react';
import * as THREE from 'three';
import {decodeRleFrame,nearestFieldFrame,type RleFrame} from '../data/fieldsV7';
import {fdsXbToThreeAabb,THERMAL_STOPS} from '../utils/coords';
import {THERMAL_MIN_C,THERMAL_MAX_C} from '../data/palettes/thermal';
import {VOLUME_VERT} from './ThermalVolume';
interface Volume {asset:string;maskAsset:string;ni:number;nj:number;nk:number;meshXb:[number,number,number,number,number,number];baseC:number;perLsbC:number;frames:RleFrame[];}
interface Dataset {scenarioId:string;volumes:Volume[];data:Record<string,Uint8Array>;}
const readiness=new Map<string,{ready:boolean;error?:string}>();
export async function waitForTemperature(id:string){const start=Date.now();while(Date.now()-start<90000){const state=readiness.get(id);if(state?.error)throw Error(state.error);if(state?.ready)return;await new Promise(r=>setTimeout(r,100));}throw Error('三维温度加载超时');}
/** RLE data is a true FDS temperature volume, not interpolation between slices. */
export default function TemperatureField({scenarioId,timeS,visible,onAvailability}:{scenarioId:string|null;timeS:number;visible:boolean;onAvailability?:(state:string)=>void}){
 const [dataset,setDataset]=useState<Dataset|null>(null);
 useEffect(()=>{
  const controller=new AbortController();setDataset(null);if(!scenarioId)return;
  readiness.set(scenarioId,{ready:false});
  onAvailability?.('正在加载三维温度');
  const base=`/assets/temperature-v11/${scenarioId}/`;
  void(async()=>{try{
   const r=await fetch(base+'manifest.json',{signal:controller.signal});if(!r.ok)throw Error('该工况三维温度未接入');const manifest=await r.json();
   if(manifest.scenarioId!==scenarioId||manifest.sceneMode!=='windowed'||!manifest.volumes.length)throw Error('三维温度身份或覆盖无效');
   const data:Record<string,Uint8Array>={};await Promise.all(manifest.volumes.flatMap((v:Volume)=>[v.asset,v.maskAsset]).map(async(asset:string)=>{const r=await fetch(base+asset,{signal:controller.signal});if(!r.ok)throw Error('三维温度文件缺失');data[asset]=new Uint8Array(await r.arrayBuffer());}));
   for(const v of manifest.volumes){if(data[v.maskAsset].length!==v.ni*v.nj*v.nk)throw Error('温度实体掩码长度错误');decodeRleFrame(data[v.asset],v.frames[0],v.ni*v.nj*v.nk);}
   if(!controller.signal.aborted){setDataset({...manifest,data});readiness.set(scenarioId,{ready:true});onAvailability?.('真实三维温度场');}
  }catch(e){if(!controller.signal.aborted){readiness.set(scenarioId,{ready:false,error:String(e)});onAvailability?.(String(e));}}})();return()=>{controller.abort();readiness.delete(scenarioId);};
 },[scenarioId,onAvailability]);
 if(!visible||dataset?.scenarioId!==scenarioId)return null;
 return <group>{dataset?.volumes.map(v=><TemperatureMesh key={v.asset} meta={v} data={dataset.data[v.asset]} mask={dataset.data[v.maskAsset]} timeS={timeS}/>)}</group>;
}
function TemperatureMesh({meta,data,mask,timeS}:{meta:Volume;data:Uint8Array;mask:Uint8Array;timeS:number}){
 const frame=nearestFieldFrame(meta.frames,timeS);
 const texture=useMemo(()=>{if(!frame)return null;const decoded=decodeRleFrame(data,frame,meta.ni*meta.nj*meta.nk);
 const tex=new THREE.Data3DTexture(new Uint8Array(decoded),meta.ni,meta.nj,meta.nk);tex.format=THREE.RedFormat;tex.type=THREE.UnsignedByteType;tex.minFilter=THREE.LinearFilter;tex.magFilter=THREE.LinearFilter;tex.unpackAlignment=1;tex.needsUpdate=true;return tex;
 },[frame,data,meta]);
 const maskTexture=useMemo(()=>{const tex=new THREE.Data3DTexture(Uint8Array.from(mask,v=>v?255:0),meta.ni,meta.nj,meta.nk);tex.format=THREE.RedFormat;tex.type=THREE.UnsignedByteType;tex.minFilter=THREE.NearestFilter;tex.magFilter=THREE.NearestFilter;tex.unpackAlignment=1;tex.needsUpdate=true;return tex;},[mask,meta]);
 useEffect(()=>()=>maskTexture.dispose(),[maskTexture]);
 useEffect(()=>()=>texture?.dispose(),[texture]);
 const box=useMemo(()=>fdsXbToThreeAabb(meta.meshXb),[meta.meshXb]);
 const paletteTexture=useMemo(()=>{
  const tex=new THREE.DataTexture(Uint8Array.from(THERMAL_STOPS.flatMap(([,rgb])=>[...rgb,255])),256,1,THREE.RGBAFormat);
  tex.minFilter=tex.magFilter=THREE.LinearFilter;tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;tex.needsUpdate=true;return tex;
 },[]);
 useEffect(()=>()=>paletteTexture.dispose(),[paletteTexture]);
 const uniforms=useMemo(()=>({uVol:{value:null as THREE.Data3DTexture|null},uMask:{value:maskTexture},uBoxMin:{value:new THREE.Vector3(...box.min)},uBoxMax:{value:new THREE.Vector3(...box.max)},uBase:{value:meta.baseC},uStep:{value:meta.perLsbC},uPalette:{value:paletteTexture},uRange:{value:new THREE.Vector2(THERMAL_MIN_C,THERMAL_MAX_C)}}),[box,meta.baseC,meta.perLsbC,maskTexture,paletteTexture]);
 useEffect(()=>{uniforms.uVol.value=texture;uniforms.uMask.value=maskTexture;},[uniforms,texture,maskTexture]);
 if(!texture)return null;
 return <mesh position={box.center} renderOrder={290}><boxGeometry args={box.size}/><shaderMaterial vertexShader={VOLUME_VERT} fragmentShader={FRAG} uniforms={uniforms} glslVersion={THREE.GLSL3} side={THREE.BackSide} transparent depthWrite={false} depthTest={false} toneMapped={false}/></mesh>;
}
const FRAG=`precision highp float;
precision highp sampler3D;
uniform sampler3D uVol,uMask; uniform vec3 uBoxMin,uBoxMax; uniform float uBase,uStep;
uniform sampler2D uPalette; uniform vec2 uRange;
in vec3 vWorld; out vec4 outColor;
vec3 tempColor(float t){float f=clamp((t-uRange.x)/(uRange.y-uRange.x),0.0,1.0);return texture(uPalette,vec2((f*255.0+.5)/256.0,.5)).rgb;}
void main(){
 vec3 ro=cameraPosition,rd=normalize(vWorld-ro);vec3 a=(uBoxMin-ro)/rd,b=(uBoxMax-ro)/rd;
 vec3 nearv=min(a,b),farv=max(a,b);float entry=max(max(nearv.x,nearv.y),nearv.z),exit=min(min(farv.x,farv.y),farv.z);
 entry=max(entry,0.0);if(exit<=entry)discard;float ds=(exit-entry)/72.0;vec4 sum=vec4(0.0);
 for(int i=0;i<72;i++){
  vec3 world=ro+rd*(entry+(float(i)+.5)*ds);vec3 uv=(world-uBoxMin)/(uBoxMax-uBoxMin);vec3 uvw=vec3(uv.x,1.0-uv.z,uv.y);
  // FDS stores nodes including both mesh endpoints; map nodes to texel centers.
  vec3 dims=vec3(textureSize(uVol,0));vec3 nodeUV=(uvw*(dims-1.0)+.5)/dims;
  if(texture(uMask,nodeUV).r<.5)continue;
  float t=uBase+texture(uVol,nodeUV).r*255.0*uStep;
  float f=clamp((t-60.0)/1140.0,0.0,1.0);vec3 color=tempColor(t);
  float density=t<=60.0?.015:mix(.1,1.2,pow(f,.5));float alpha=1.0-exp(-density*ds);
  sum.rgb+=(1.0-sum.a)*alpha*color;sum.a+=(1.0-sum.a)*alpha;if(sum.a>.93)break;
 }
 if(sum.a<.002)discard;outColor=vec4(sum.rgb/max(sum.a,.001),sum.a);
}`;
