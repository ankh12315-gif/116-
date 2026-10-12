import {useEffect,useMemo,useRef,useState} from 'react';
import * as THREE from 'three';
import {useFrame} from '@react-three/fiber';
import {decodeRleFrame,nearestFieldFrame,type FieldVolume,type FieldManifest} from '../data/fieldsV7';
import {fdsXbToThreeAabb} from '../utils/coords';
import {visualization} from '../config/visualization';
import {VOLUME_VERT} from './ThermalVolume';
/** True soot optical opacity / local HRRPUV only; no particle motion or temperature-derived smoke. */
export default function DisasterVolumes({manifest,data,timeS,releaseActive=true,showSmoke=true}:{manifest:FieldManifest|null;data:Record<string,Uint8Array>;timeS:number;releaseActive?:boolean;showSmoke?:boolean}){
 if(!manifest)return null;return <group>{manifest.volumes.filter(v=>v.quantity==='HRRPUV'?releaseActive:showSmoke).map(v=><OpticalVolume key={v.asset} meta={v} bin={data[v.asset]} timeS={timeS}/>)}</group>;
}
function OpticalVolume({meta,bin,timeS}:{meta:FieldVolume;bin:Uint8Array|undefined;timeS:number}){
 const frame=nearestFieldFrame(meta.frames,timeS),fire=meta.quantity==='HRRPUV';
 const texture=useMemo(()=>{if(!bin||!frame)return null;const source=decodeRleFrame(bin,frame,meta.ni*meta.nj*meta.nk);
 // sampler coordinates are FDS (x,y,z); no transpose needed. World→FDS handled by shader.
 const tex=new THREE.Data3DTexture(new Uint8Array(source),meta.ni,meta.nj,meta.nk);tex.format=THREE.RedFormat;tex.type=THREE.UnsignedByteType;tex.minFilter=THREE.LinearFilter;tex.magFilter=THREE.LinearFilter;tex.unpackAlignment=1;tex.needsUpdate=true;return tex;
 },[bin,frame,meta]);
 useEffect(()=>()=>texture?.dispose(),[texture]);
 const box=useMemo(()=>fdsXbToThreeAabb(meta.meshXb as [number,number,number,number,number,number]),[meta.meshXb]);
 const uniforms=useMemo(()=>({uVol:{value:null as THREE.Data3DTexture|null},uBoxMin:{value:new THREE.Vector3(...box.min)},uBoxMax:{value:new THREE.Vector3(...box.max)},uDx:{value:meta.dxM},uFire:{value:fire?1:0},uScale:{value:fire?1:visualization.smokeOpacityScale},uSteps:{value:visualization.raySteps}}),[box,meta.dxM,fire]);
 useEffect(()=>{uniforms.uVol.value=texture;},[texture,uniforms]);
 if(!texture||!frame||frame.maxByte===0)return null;
 return <mesh position={box.center} renderOrder={fire?310:300}><boxGeometry args={box.size}/><shaderMaterial uniforms={uniforms} vertexShader={VOLUME_VERT} fragmentShader={OPTICAL_FRAG} glslVersion={THREE.GLSL3} side={THREE.BackSide} transparent depthWrite={false} depthTest={false} toneMapped={false}/></mesh>;
}
export const OPTICAL_FRAG=`
precision highp float; precision highp sampler3D;
uniform sampler3D uVol; uniform vec3 uBoxMin,uBoxMax; uniform float uDx,uScale; uniform int uFire,uSteps;
in vec3 vWorld; out vec4 fragColor;
void main(){vec3 ro=cameraPosition,rd=normalize(vWorld-ro);vec3 safe=sign(rd+vec3(1.e-10))*max(abs(rd),vec3(1.e-8));vec3 a=(uBoxMin-ro)/safe,b=(uBoxMax-ro)/safe;vec3 lo=min(a,b),hi=max(a,b);float t0=max(max(lo.x,lo.y),lo.z),t1=min(min(hi.x,hi.y),hi.z);t0=max(t0,0.);if(t1<=t0)discard;
float dt=(t1-t0)/float(uSteps);vec4 acc=vec4(0.);
for(int i=0;i<128;i++){if(i>=uSteps)break;vec3 p=ro+rd*(t0+(float(i)+.5)*dt);vec3 worldUV=(p-uBoxMin)/(uBoxMax-uBoxMin);
// Three(x,z,-y) AABB → FDS(x,y,z) texture, with reversed second coordinate.
vec3 uvw=vec3(worldUV.x,1.-worldUV.z,worldUV.y);vec3 dims=vec3(textureSize(uVol,0));vec3 nodeUV=(uvw*(dims-1.)+.5)/dims;float q=texture(uVol,nodeUV).r*255.;float alpha;vec3 color;
if(uFire==1){float strength=q/254.;if(strength<.025)continue;alpha=1.-exp(-strength*2.0*dt);color=mix(vec3(1.,.15,.01),vec3(1.,.95,.15),sqrt(strength));}
else{float tau=-log(max(1.-q/254.,1./254.))/uDx;alpha=1.-exp(-tau*dt*uScale);color=mix(vec3(.31,.29,.27),vec3(.13,.12,.11),clamp(tau*.08,0.,1.));}
acc.rgb+=(1.-acc.a)*color*alpha;acc.a+=(1.-acc.a)*alpha;if(acc.a>.88)break;}
if(acc.a<.004)discard;fragColor=vec4(acc.rgb/max(acc.a,1.e-5),min(acc.a,.88));}`;
/** Small internal statistics for browser QA; no permanent dashboard. */
export const renderMetrics={fps:0,drawCalls:0,triangles:0,textures:0,geometries:0};
export function RenderMetrics(){const samples=useRef<number[]>([]);useFrame(({gl},dt)=>{samples.current.push(dt);if(samples.current.length>=60){renderMetrics.fps=60/samples.current.reduce((a,b)=>a+b,0);renderMetrics.drawCalls=gl.info.render.calls;renderMetrics.triangles=gl.info.render.triangles;renderMetrics.textures=gl.info.memory.textures;renderMetrics.geometries=gl.info.memory.geometries;samples.current=[];}});return null;}

export function RenderMetricsOutput(){const [metrics,setMetrics]=useState({...renderMetrics});useEffect(()=>{const id=setInterval(()=>setMetrics({...renderMetrics}),2000);return()=>clearInterval(id);},[]);return <output id="render-metrics" hidden data-fps={metrics.fps.toFixed(1)} data-draw-calls={metrics.drawCalls} data-triangles={metrics.triangles} data-textures={metrics.textures} data-geometries={metrics.geometries}/>;}
