import type {SliceMeta} from '../types/domain';
import {findSliceFrameIndex} from '../data/scenarioProvider';
import {dequantizeTemp,fdsToThree,quantSpecFromSlice,temperatureToAlpha} from './coords';
export function visibleHeatAlpha(c:number):number{return c<=60?.1:Math.min(.9,Math.sqrt(temperatureToAlpha(c))*1.8);}
export function heatExtent(slices:SliceMeta[],data:Record<string,Uint8Array|Float32Array>,timeS:number,origin:number[]|undefined){
 let maxC=-Infinity,point:[number,number,number]|null=null,warmCount=0,maxDistanceM=0,frameTimeS=0;
 for(const sl of slices){const bin=data[sl.asset],frame=findSliceFrameIndex(sl,timeS);if(!bin||!frame)continue;const q=quantSpecFromSlice(sl);frameTimeS=sl.frameTimesS[frame.index];const start=frame.index*sl.ni*sl.nj;
  for(let j=0;j<sl.nj;j++)for(let i=0;i<sl.ni;i++){const byte=bin[start+j*sl.ni+i];if(byte===undefined)continue;const c=bin instanceof Float32Array?byte:dequantizeTemp(byte,q.baseC,q.scaleC,q.mode);if(!Number.isFinite(c))continue;
   const x=sl.uRangeM[0]+i*(sl.uRangeM[1]-sl.uRangeM[0])/(sl.ni-1),y=sl.vRangeM[0]+j*(sl.vRangeM[1]-sl.vRangeM[0])/(sl.nj-1);
   const xyz:[number,number,number]=sl.plane==='PBX'?[sl.planeCoordM,x,y]:sl.plane==='PBY'?[x,sl.planeCoordM,y]:[x,y,sl.planeCoordM];
   if(c>maxC){maxC=c;point=xyz;}if(c>=40){warmCount++;if(origin)maxDistanceM=Math.max(maxDistanceM,Math.hypot(xyz[0]-origin[0],xyz[1]-origin[1]));}
  }
 }return {maxC:Number.isFinite(maxC)?maxC:null,point,warmCount,maxDistanceM,frameTimeS};
}
/** 从真实节点线性求40℃等温线，仅标示截面，非燃烧边界。 */
export function warmContours(slices:SliceMeta[],data:Record<string,Uint8Array|Float32Array>,timeS:number,threshold=40){
 const lines:number[]=[];
 for(const sl of slices){const bin=data[sl.asset],frame=findSliceFrameIndex(sl,timeS);if(!bin||!frame||sl.plane!=='PBZ')continue;const q=quantSpecFromSlice(sl),start=frame.index*sl.ni*sl.nj;
  const value=(i:number,j:number)=>{const v=bin[start+j*sl.ni+i];return bin instanceof Float32Array?v:dequantizeTemp(v,q.baseC,q.scaleC,q.mode);};
  for(let j=0;j<sl.nj-1;j++)for(let i=0;i<sl.ni-1;i++){
   const corners=[[i,j],[i+1,j],[i+1,j+1],[i,j+1]],hits:number[][]=[];
   for(let edge=0;edge<4;edge++){const a=corners[edge],b=corners[(edge+1)%4],va=value(a[0],a[1]),vb=value(b[0],b[1]);if(!Number.isFinite(va)||!Number.isFinite(vb)||(va>=threshold)===(vb>=threshold))continue;const f=(threshold-va)/(vb-va),u=a[0]+f*(b[0]-a[0]),v=a[1]+f*(b[1]-a[1]);hits.push(fdsToThree(sl.uRangeM[0]+u*(sl.uRangeM[1]-sl.uRangeM[0])/(sl.ni-1),sl.vRangeM[0]+v*(sl.vRangeM[1]-sl.vRangeM[0])/(sl.nj-1),sl.planeCoordM+.015));}
   for(let k=0;k+1<hits.length;k+=2)lines.push(...hits[k],...hits[k+1]);
  }
 }return new Float32Array(lines);
}
