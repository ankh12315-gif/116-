import * as THREE from 'three';
/** Move along the existing view direction until every room corner has safe margins. */
export function fitRoomCamera(camera:THREE.PerspectiveCamera,position:THREE.Vector3,target:THREE.Vector3,bounds:THREE.Box3,points?:THREE.Vector3[]){
 const probe=camera.clone(),direction=position.clone().sub(target),corners=points??[];
 if(!points)for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])corners.push(new THREE.Vector3(x,y,z));
 const fits=(scale:number)=>{
  probe.position.copy(target).addScaledVector(direction,scale);probe.lookAt(target);probe.updateProjectionMatrix();probe.updateMatrixWorld(true);
  return corners.every(p=>{const ndc=p.clone().project(probe);return Math.abs(ndc.x)<=(points ? .94 : .9)&&Math.abs(ndc.y)<=(points ? .92 : .82)&&ndc.z>-1&&ndc.z<1;});
 };
 let lo=.1,hi=1;while(!fits(hi)&&hi<64)hi*=1.25;
 // Closest complete framing, rather than keeping an unnecessarily distant initial camera.
 for(let i=0;i<24;i++){const mid=(lo+hi)/2;if(fits(mid))hi=mid;else lo=mid;}
 return target.clone().addScaledVector(direction,hi*1.005);
}

/** Fit the projected silhouette and center it in the usable area, keeping view direction/FOV. */
export function centeredRoomFraming(camera:THREE.PerspectiveCamera,position:THREE.Vector3,target:THREE.Vector3,points:THREE.Vector3[],width:number,height:number,topPadding=80){
 const probe=camera.clone();probe.clearViewOffset();probe.aspect=width/height;
 const direction=position.clone().sub(target),top=1-2*topPadding/height,bottom=-.94;
 const extent=(scale:number)=>{
  probe.position.copy(target).addScaledVector(direction,scale);probe.lookAt(target);probe.updateProjectionMatrix();probe.updateMatrixWorld(true);
  let min=Infinity,max=-Infinity,valid=true;
  for(const point of points){const p=point.clone().project(probe);min=Math.min(min,p.y);max=Math.max(max,p.y);if(Math.abs(p.x)>.95||p.z<=-1||p.z>=1)valid=false;}
  return {min,max,fits:valid&&max-min<=top-bottom};
 };
 let lo=.1,hi=1;while(!extent(hi).fits&&hi<64)hi*=1.25;
 for(let i=0;i<24;i++){const mid=(lo+hi)/2;if(extent(mid).fits)hi=mid;else lo=mid;}
 const scale=hi*1.005,e=extent(scale),shift=(top+bottom-e.min-e.max)/2;
 return {position:target.clone().addScaledVector(direction,scale),offsetY:shift*height/2};
}
