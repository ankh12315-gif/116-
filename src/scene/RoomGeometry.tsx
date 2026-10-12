/** 所有几何仍来自scene_master；分组仅控制材质，不确认建筑/柜体语义。 */
import {useEffect,useLayoutEffect,useMemo,useRef} from 'react';
import * as THREE from 'three';
import {useFrame} from '@react-three/fiber';
import type {SceneMaster} from '../types/domain';
import {fdsXbToThreeAabb} from '../utils/coords';
import {surfaceMatrix} from '../utils/surfaceGeometry';
interface Props{scene:SceneMaster;wallOpacity:number;showRoof:boolean;highlightCenter:[number,number,number]|null;dimOthers:boolean;}
type Instance={matrix:THREE.Matrix4;color:string;};
function color(fam:string,z:number){
  if(fam==='METAL_GRAY')return '#9caaa8';
  if(fam==='COLOR_CYAN')return '#b8c4ba';
  if(fam==='COLOR_RED')return '#b4aa96';
  if(fam==='COLOR_YELLOW')return '#cab995';
  return z<3?'#ded6c6':'#f1e4ce';
}
function Batch({items,plane=false,opacity=1}:{items:Instance[];plane?:boolean;opacity?:number}){
  const ref=useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(()=>{const m=ref.current;if(!m)return;items.forEach((x,i)=>{m.setMatrixAt(i,x.matrix);m.setColorAt(i,new THREE.Color(x.color));});m.instanceMatrix.needsUpdate=true;if(m.instanceColor)m.instanceColor.needsUpdate=true;m.computeBoundingSphere();},[items]);
  if(!items.length)return null;
  return <instancedMesh ref={ref} args={[undefined,undefined,items.length]} castShadow={opacity===1} receiveShadow>
    {plane?<planeGeometry args={[1,1]}/>:<boxGeometry args={[1,1,1]}/>}
    <meshStandardMaterial side={THREE.DoubleSide} roughness={0.66} metalness={0.12} transparent={opacity<1} opacity={opacity} depthWrite={opacity===1} polygonOffset={plane} polygonOffsetFactor={-1} polygonOffsetUnits={-1}/>
  </instancedMesh>;
}
export default function RoomGeometry({scene,wallOpacity,showRoof,highlightCenter}:Props){
 const groups=useMemo(()=>{
  const solid:Instance[]=[],outerSolid:Instance[]=[],surface:Instance[]=[],outerSurface:Instance[]=[],roof:Instance[]=[];const edges:number[]=[];
  for(const s of scene.solids){const a=fdsXbToThreeAabb(s.xb);const tall=a.size[1]>3||s.xb[4]>=2.8;const matrix=new THREE.Matrix4().compose(new THREE.Vector3(...a.center),new THREE.Quaternion(),new THREE.Vector3(...a.size));(tall?outerSolid:solid).push({matrix,color:color(s.fam,s.xb[5])});
   // 真实实体外轮廓，微弱线条改善结构层次；没有新增建筑实体。
   const base=new THREE.BoxGeometry(1,1,1);const e=new THREE.EdgesGeometry(base);e.applyMatrix4(matrix);edges.push(...Array.from(e.attributes.position.array));e.dispose();base.dispose();
  }
  for(const s of scene.surfaces){const [x1,x2,y1,y2,z1,z2]=s.xb;const dx=x2-x1,dy=y2-y1,dz=z2-z1;   if((dx<1e-6&&dy<1e-6)||(dx<1e-6&&dz<1e-6)||(dy<1e-6&&dz<1e-6))continue;
   const matrix=surfaceMatrix(s.xb);const list=dz<1e-6&&z1>5.5?roof:dz>3||z1>=2.8?outerSurface:surface;
   list.push({matrix,color:z2<0.1?'#d5c3a4':color(s.fam,z2)});
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(edges,3));
  return {solid,outerSolid,surface,outerSurface,roof,geometry};
 },[scene]);
 useEffect(()=>()=>groups.geometry.dispose(),[groups.geometry]);
 const hl=useRef<THREE.Mesh>(null);useFrame(({clock})=>{if(hl.current)hl.current.scale.setScalar(1+Math.sin(clock.elapsedTime*2.5)*.08);});
 const a=fdsXbToThreeAabb(scene.coordinateSystem.bbox);
 return <group>
  <mesh position={[a.center[0],-.025,a.center[2]]} rotation={[-Math.PI/2,0,0]} receiveShadow><planeGeometry args={[a.size[0],a.size[2]]}/><meshStandardMaterial color="#d9c9ac" roughness={.9}/></mesh>
  <Batch items={groups.solid}/><Batch items={groups.outerSolid} opacity={wallOpacity}/>
  <Batch items={groups.surface} plane/><Batch items={groups.outerSurface} plane opacity={wallOpacity}/>
  {showRoof&&<Batch items={groups.roof} plane opacity={wallOpacity}/>}
  <lineSegments geometry={groups.geometry}><lineBasicMaterial color="#736b5d" transparent opacity={.12}/></lineSegments>
  {highlightCenter&&<mesh ref={hl} position={highlightCenter} renderOrder={999}><sphereGeometry args={[.32,24,16]}/><meshBasicMaterial color="#d64b2e" transparent opacity={.65} depthTest={false}/></mesh>}
 </group>;
}
