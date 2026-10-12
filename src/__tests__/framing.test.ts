import {it,expect} from 'vitest';
import * as THREE from 'three';
import {fitRoomCamera,centeredRoomFraming} from '../utils/framing';
import fs from 'node:fs';
for(const [width,height] of [[1920,872],[1366,640],[1753,653]])it(`whole room corners stay in canvas at ${width}x${height}`,()=>{
 const box=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(15,6.5,19.5)),target=box.getCenter(new THREE.Vector3());target.y=3;
 const camera=new THREE.PerspectiveCamera(32,width/height,.1,400),initial=target.clone().add(new THREE.Vector3(20,18,26));
 camera.position.copy(fitRoomCamera(camera,initial,target,box));camera.lookAt(target);camera.updateMatrixWorld(true);
 expect(camera.position.clone().sub(target).normalize().distanceTo(initial.clone().sub(target).normalize())).toBeLessThan(1e-10);
 for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
  const p=new THREE.Vector3(x,y,z).project(camera);expect(Math.abs(p.x)).toBeLessThanOrEqual(.9);expect(Math.abs(p.y)).toBeLessThanOrEqual(.82);expect(p.z).toBeGreaterThan(-1);expect(p.z).toBeLessThan(1);
 }
});
for(const [width,height] of [[1920,824],[1366,680]])it(`centered framing uses upper whitespace without cutting room at ${width}x${height}`,()=>{
 const scene=JSON.parse(fs.readFileSync('public/assets/geometry/scene_master.json','utf8')),b=scene.coordinateSystem.bbox;
 const box=new THREE.Box3(new THREE.Vector3(b[0],b[4],-b[3]),new THREE.Vector3(b[1],b[5],-b[2]));
 const center=box.getCenter(new THREE.Vector3()),radius=box.min.distanceTo(box.max),target=new THREE.Vector3(center.x,3,center.z),camera=new THREE.PerspectiveCamera(32,width/height,.1,400);
 const initial=center.clone().add(new THREE.Vector3(radius*.72,radius*.66,radius*.92)),points:THREE.Vector3[]=[];
 for(const xb of [[b[0],b[1],b[2],b[3],0,0],...scene.solids.map((s:{xb:number[]})=>s.xb),...scene.surfaces.map((s:{xb:number[]})=>s.xb)])for(const x of [xb[0],xb[1]])for(const y of [xb[2],xb[3]])for(const z of [xb[4],xb[5]])points.push(new THREE.Vector3(x,z,-y));
 const previous=fitRoomCamera(camera,initial,target,box,points),framing=centeredRoomFraming(camera,initial,target,points,width,height);
 expect(framing.position.distanceTo(target)).toBeLessThan(previous.distanceTo(target));
 camera.position.copy(framing.position);camera.lookAt(target);camera.setViewOffset(width,height,0,framing.offsetY,width,height);camera.updateMatrixWorld(true);
 const top=1-160/height;let low=Infinity,high=-Infinity;
 for(const point of points){const p=point.clone().project(camera);expect(Math.abs(p.x)).toBeLessThan(.95);expect(p.y).toBeGreaterThanOrEqual(-.94);expect(p.y).toBeLessThanOrEqual(top);low=Math.min(low,p.y);high=Math.max(high,p.y);}
 expect(high-low).toBeGreaterThan((top+.94)*.95);
});
for(const [width,height] of [[1920,734],[1366,590]])it(`fire framing is larger while keeping the full floor at ${width}x${height}`,()=>{
 const scene=JSON.parse(fs.readFileSync('public/assets/geometry/scene_master.json','utf8')),b=scene.coordinateSystem.bbox;
 const center=new THREE.Vector3((b[0]+b[1])/2,(b[4]+b[5])/2,-(b[2]+b[3])/2),target=new THREE.Vector3(center.x,3,center.z);
 const initial=center.clone().add(new THREE.Vector3(25,23,32)),camera=new THREE.PerspectiveCamera(32,width/height,.1,400),points:THREE.Vector3[]=[];
 for(const xb of [[b[0],b[1],b[2],b[3],0,0],...scene.solids.map((s:{xb:number[]})=>s.xb),...scene.surfaces.map((s:{xb:number[]})=>s.xb)])for(const x of [xb[0],xb[1]])for(const y of [xb[2],xb[3]])for(const z of [xb[4],xb[5]])points.push(new THREE.Vector3(x,z,-y));
 const old=centeredRoomFraming(camera,initial,target,points,width,height,140),next=centeredRoomFraming(camera,initial,target,points,width,height,40);
 expect(next.position.distanceTo(target)).toBeLessThan(old.position.distanceTo(target)*.9);
 camera.position.copy(next.position);camera.lookAt(target);camera.setViewOffset(width,height,0,next.offsetY,width,height);camera.updateMatrixWorld(true);
 for(const point of points){const p=point.clone().project(camera);expect(Math.abs(p.x)).toBeLessThan(.95);expect(p.y).toBeGreaterThanOrEqual(-.94);expect(p.y).toBeLessThanOrEqual(1-80/height);}
});
it('real FDS structures get closer framing while the entire ground stays visible',()=>{
 const scene=JSON.parse(fs.readFileSync('public/assets/geometry/scene_master.json','utf8')),b=scene.coordinateSystem.bbox;
 const box=new THREE.Box3(new THREE.Vector3(b[0],b[4],-b[3]),new THREE.Vector3(b[1],b[5],-b[2]));
 const center=box.getCenter(new THREE.Vector3()),radius=box.min.distanceTo(box.max),target=new THREE.Vector3(center.x,3,center.z);
 const initial=center.clone().add(new THREE.Vector3(radius*.72,radius*.66,radius*.92)),camera=new THREE.PerspectiveCamera(32,1920/824,.1,400);
 const points:THREE.Vector3[]=[];
 for(const xb of [[b[0],b[1],b[2],b[3],0,0],...scene.solids.map((s:{xb:number[]})=>s.xb),...scene.surfaces.map((s:{xb:number[]})=>s.xb)])for(const x of [xb[0],xb[1]])for(const y of [xb[2],xb[3]])for(const z of [xb[4],xb[5]])points.push(new THREE.Vector3(x,z,-y));
 const conservative=fitRoomCamera(camera,initial,target,box),closer=fitRoomCamera(camera,initial,target,box,points);
 expect(closer.distanceTo(target)).toBeLessThan(conservative.distanceTo(target));camera.position.copy(closer);camera.lookAt(target);camera.updateMatrixWorld(true);
 for(const point of points){const p=point.clone().project(camera);expect(Math.abs(p.x)).toBeLessThan(.94);expect(Math.abs(p.y)).toBeLessThan(.92);}
});
