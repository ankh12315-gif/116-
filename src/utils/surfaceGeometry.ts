import * as THREE from 'three';
import {fdsToThree} from './coords';
/** 单位XY平面的变换；不改变源XB。Three=[FDS x,FDS z,-FDS y]。 */
export function surfaceMatrix(xb:readonly number[]):THREE.Matrix4 {
 const [x1,x2,y1,y2,z1,z2]=xb,dx=x2-x1,dy=y2-y1,dz=z2-z1;
 const pos=new THREE.Vector3(...fdsToThree((x1+x2)/2,(y1+y2)/2,(z1+z2)/2));
 const rot=dz<1e-6?new THREE.Euler(-Math.PI/2,0,0):dx<1e-6?new THREE.Euler(0,Math.PI/2,0):new THREE.Euler(0,0,0);
 const scale=dz<1e-6?new THREE.Vector3(dx,dy,1):dx<1e-6?new THREE.Vector3(dy,dz,1):new THREE.Vector3(dx,dz,1);
 return new THREE.Matrix4().compose(pos,new THREE.Quaternion().setFromEuler(rot),scale);
}
