/**
 * 三维场景根组件：真实 FDS 几何 + 起火柜锚点 + FDS 温度切片
 *
 * 相机：透视/正交可切换，OrbitControls 自由旋转/缩放/平移/重置。
 * 约束：不允许穿墙、陷入地下。
 */

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { Html, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import RoomGeometry from './RoomGeometry';
import CabinetAnchors from './CabinetAnchors';
import BeamSensorMarker from './BeamSensorMarker';
import ThermalSlices from './ThermalSlices';
import type { SliceFrameStats } from './ThermalSlices';
import ThermalVolume from './ThermalVolume';
import TemperatureField from './TemperatureField';
import DisasterVolumes,{RenderMetrics} from './DisasterVolumes';
import type {FieldManifest} from '../data/fieldsV7';
import type { VolumeFrameInfo } from './ThermalVolume';
import type {
  Cabinet,
  SceneMaster,
  SliceMeta,
  VolumeManifest,
} from '../types/domain';
import { bboxCenterThree, bboxDiagonal, fdsToThree } from '../utils/coords';
import { findSliceFrameIndex } from '../data/scenarioProvider';
import {warmContours} from '../utils/heatPresentation';
import {centeredRoomFraming} from '../utils/framing';

/**
 * DESIGN_SYSTEM §2.5：默认 fov 32°（长焦压缩，接近建筑摄影）。
 * 不要改回 38/50°——大 fov 会让 15×19.5m 房间边缘透视变形。
 */
export const FOV = 32;

interface Props {
  beamSensorPoint?:[number,number,number]|null;
  monitoring?:boolean;
  temperatureVisible?:boolean;
  temperatureVolume?:boolean;
  showSmoke?:boolean;
  temperatureScenarioId?:string|null;
  onTemperatureAvailability?:(state:string)=>void;
  sceneVisible?:boolean;
  releaseActive?:boolean;
  scene: SceneMaster;
  cabinets: Cabinet[];
  selectedCabinetId: string | null;
  zoneFilter: 'ALL' | 'HIGH' | 'LOW';
  wallOpacity: number;
  showRoof: boolean;
  showCabinetLabels: boolean;
  showSlices: boolean;
  slicePlane: 'PBZ' | 'PBX' | 'PBY';
  slices: SliceMeta[];
  sliceData: Record<string, Uint8Array|Float32Array>;
  heatPeak?:{point:[number,number,number]|null;maxC:number|null};
  heatTopView?:boolean;
  multiSlices?:boolean;
  disasterManifest?:FieldManifest|null;
  disasterData?:Record<string,Uint8Array>;
  /** 体数据清单；null = 该工况未接入体数据（其余 15 工况） */
  volumeManifest: VolumeManifest | null;
  volumeData: Record<string, Uint8Array>;
  volumeLoading: boolean;
  showVolume: boolean;
  currentTimeS: number;
  /** 含未来偏移的查询时刻（体数据与切片各自取最近邻帧） */
  effectiveTimeS: number;
  alarmLevels: Record<string, 'NORMAL' | 'TEMPERATURE_WARNING' | 'FIRE_ALARM' | 'UNKNOWN'>;
  /** 是否点亮火源点光（仅 FIRE_ALARM 时为 true，正常工况必须 false） */
  fireAlarmLit: boolean;
  onSelectCabinet: (id: string) => void;
  focusToken: number;
  onSliceFrameStats?: (list: SliceFrameStats[]) => void;
  onVolumeFrameInfo?: (info: VolumeFrameInfo | null) => void;
}

export default function SceneRoot(props: Props) {
  const ortho = false;
  const controlsRef = useRef<OrbitControlsImpl>(null);

  const boundsKey=props.scene.coordinateSystem.bbox.join(",");
  const { center, radius } = useMemo(() => {
    if (!props.scene) return { center: new THREE.Vector3(), radius: 20 };
    const bbox = props.scene.coordinateSystem.bbox;
    return {
      center: new THREE.Vector3(...bboxCenterThree(bbox)),
      radius: bboxDiagonal(bbox),
    };
  }, [boundsKey]);

  const camPos = useMemo(
    () => new THREE.Vector3(center.x + radius * 0.72, center.y + radius * 0.66, center.z + radius * 0.92),
    [center, radius],
  );

  const highlightCenter = useMemo(() => {
    if (!props.selectedCabinetId) return null;
    const c = props.cabinets.find((x) => x.id === props.selectedCabinetId);
    return c ? fdsToThree(...c.burnerCenterFdsM) : null;
  }, [props.selectedCabinetId, props.cabinets]);
  const framingPoints=useMemo(()=>{
    const points:THREE.Vector3[]=[];
    // Fit actual structures and the ground, not empty upper corners of the FDS domain.
    const floor=[...props.scene.coordinateSystem.bbox];floor[4]=floor[5]=0;
    for(const xb of [floor,...props.scene.solids.map(s=>s.xb),...props.scene.surfaces.map(s=>s.xb)]){
      for(const x of [xb[0],xb[1]])for(const y of [xb[2],xb[3]])for(const z of [xb[4],xb[5]])points.push(new THREE.Vector3(x,z,-y));
    }
    return points;
  },[props.scene]);

  // 切片帧索引（取最近真实帧，不插值）
  const sliceFrameIndex = useMemo(() => {
    const candidates = props.slices.filter((s) => s.plane === props.slicePlane);
    if (candidates.length === 0) return 0;
    const first = candidates[0];
    const r = findSliceFrameIndex(first, props.effectiveTimeS);
    return r ? r.index : 0;
  }, [props.slices, props.slicePlane, props.effectiveTimeS]);

  const handleSliceStats = useCallback(
    (s: SliceFrameStats) => {
      props.onSliceFrameStats?.([s]);
    },
    [props.onSliceFrameStats],
  );
  const contourFrameKey=props.slices.map(sl=>findSliceFrameIndex(sl,props.effectiveTimeS)?.index??-1).join(',');
  const contour=useMemo(()=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(warmContours(props.slices,props.sliceData,props.effectiveTimeS),3));return g;},[props.slices,props.sliceData,contourFrameKey]);
  useEffect(()=>()=>contour.dispose(),[contour]);

  const handleVolumeFrame = useCallback(
    (info: VolumeFrameInfo | null) => {
      props.onVolumeFrameInfo?.(info);
    },
    [props.onVolumeFrameInfo],
  );

  const target = [center.x, Math.min(center.y, 3), center.z] as [number, number, number];

  return (
    <div className="scene-root">
      <Canvas
        shadows
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ fov: FOV, near: 0.1, far: 400, position: camPos.toArray() }}
        onCreated={({ gl, scene: s }) => {
          // DESIGN_SYSTEM §2.1：NeutralToneMapping 保住白点。
          // 不可用时（three 版本过低）退回 Linear，同样不能用 ACESFilmic
          // —— 它会把暖白 #F5F3EE 压成灰黄，直接破坏 P4 的白。
          gl.toneMapping = THREE.NeutralToneMapping ?? THREE.LinearToneMapping;
          gl.toneMappingExposure = 1.0;
          gl.outputColorSpace = THREE.SRGBColorSpace;
          // 背景透明，让 CSS 的 --c-bg 透出
          gl.setClearColor('#f5f3ee', 0);
          s.fog = new THREE.Fog('#f5f3ee', radius * 1.6, radius * 4.2);
        }}
      >
        <Suspense fallback={null}>
          {/* 灯光：DESIGN_SYSTEM §2.2 */}
          <hemisphereLight args={['#fff9ed', '#c6bba8', 0.8]} />
          <ambientLight intensity={0.26} />
          <directionalLight
            position={[14, 22, 10]}
            intensity={1.65}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-bias={-0.0005}
            shadow-normalBias={0.02}
            shadow-camera-near={1}
            shadow-camera-far={120}
            shadow-camera-left={-radius}
            shadow-camera-right={radius}
            shadow-camera-top={radius}
            shadow-camera-bottom={-radius}
          />
          <directionalLight position={[-12, 8, -10]} intensity={0.4} color="#fff4de" />

          {/* 火源点光：仅报警时点亮，正常工况强度必须为 0
              （DESIGN_SYSTEM §2.2 —— 唯一允许的有色光源）*/}
          <pointLight
            position={highlightCenter ? [...highlightCenter] : [0, -999, 0]}
            color="#ff7a3d"
            intensity={props.fireAlarmLit ? 1.1 : 0}
            distance={6}
            decay={2}
          />

          {ortho ? (
            <OrthographicCamera
              makeDefault
              position={camPos.toArray()}
              zoom={90}
              near={0.1}
              far={400}
            />
          ) : (
            <PerspectiveCamera makeDefault fov={FOV} near={0.1} far={400} position={camPos.toArray()} />
          )}

          <group position={[0, 0, 0]} visible={props.sceneVisible!==false}>
            <RoomGeometry
              scene={props.scene}
              wallOpacity={props.wallOpacity}
              showRoof={props.showRoof}
              highlightCenter={highlightCenter}
              dimOthers={props.zoneFilter !== 'ALL'}
            />

            {props.showSlices && props.slices.length > 0 && (
              <>
                <lineSegments geometry={contour} renderOrder={600}><lineBasicMaterial color="#d84b21" transparent opacity={.85} depthTest={false} depthWrite={false}/></lineSegments>
                <ThermalSlices
                  slices={props.slices}
                  sliceData={props.sliceData}
                  plane={props.multiSlices?'ALL':props.slicePlane}
                  frameIndex={sliceFrameIndex}
                  timeS={props.effectiveTimeS}
                  opacity={props.multiSlices?.58:.92}
                  visible
                  onFrameStats={handleSliceStats}
                />
              </>
            )}

            {/* 体数据（.s3d）：与切片独立开关。
                仅 HV-01-140MW 有 volume/manifest.json，其余 15 工况
                volumeManifest 为 null → 组件返回 null，不报错也不空白。 */}
            <ThermalVolume
              manifest={props.volumeManifest}
              volumeData={props.volumeData}
              loading={props.volumeLoading}
              timeS={props.effectiveTimeS}
              visible={props.showVolume}
              opacity={0.92}
              onFrameInfo={handleVolumeFrame}
            />

            <TemperatureField scenarioId={props.temperatureScenarioId??null} timeS={props.effectiveTimeS} visible={!!props.temperatureVisible&&!!props.temperatureVolume} onAvailability={props.onTemperatureAvailability}/>
            <DisasterVolumes manifest={props.disasterManifest??null} data={props.disasterData??{}} timeS={props.effectiveTimeS} releaseActive={props.releaseActive} showSmoke={props.showSmoke}/>
            <RenderMetrics/>
            {props.beamSensorPoint&&<BeamSensorMarker point={props.beamSensorPoint}/>}
            <CabinetAnchors
              cabinets={props.cabinets}
              selectedId={props.selectedCabinetId}
              zoneFilter={props.zoneFilter}
              showLabels={props.showCabinetLabels}
              alarmLevel={props.alarmLevels}
              onSelect={props.onSelectCabinet}
            />
            {props.showSlices&&props.heatPeak?.point&&props.heatPeak.maxC!==null&&props.heatPeak.maxC>=40&&<Html position={fdsToThree(...props.heatPeak.point)} center zIndexRange={[25,0]}><span className="heat-peak">切面最高 {props.heatPeak.maxC.toFixed(0)}℃</span></Html>}
          </group>

          <OrbitControls
            ref={controlsRef}
            makeDefault
            target={target}
            enableDamping
            dampingFactor={0.08}
            minDistance={2}
            maxDistance={radius * 3}
            maxPolarAngle={Math.PI / 2.02} // 防止钻到地下
            minPolarAngle={0.08}
            screenSpacePanning={false}
          />
          <ResponsiveFraming center={center} camPos={camPos} radius={radius} controlsRef={controlsRef} points={framingPoints} monitoring={props.monitoring}/>
          <AutomaticFocus point={highlightCenter} token={props.focusToken} controlsRef={controlsRef} center={center}/>
          <TopHeatView enabled={props.heatTopView??false} center={center} radius={radius} controlsRef={controlsRef}/>
        </Suspense>
      </Canvas>

      {/* 相机工具：右下 */}
    </div>
  );
}

function TopHeatView({enabled,center,radius,controlsRef}:{enabled:boolean;center:THREE.Vector3;radius:number;controlsRef:React.RefObject<OrbitControlsImpl>}){
 const {camera,size}=useThree();const saved=useRef<{position:THREE.Vector3;target:THREE.Vector3}|null>(null);
 useEffect(()=>{const controls=controlsRef.current;if(!controls)return;
  if(enabled){if(!saved.current)saved.current={position:camera.position.clone(),target:controls.target.clone()};controls.target.set(center.x,3,center.z);camera.position.set(center.x,3+radius*1.6*Math.max(1,1.1/(size.width/size.height)),center.z+.01);camera.lookAt(controls.target);controls.update();}
  else if(saved.current){camera.position.copy(saved.current.position);controls.target.copy(saved.current.target);saved.current=null;controls.update();}
 },[enabled,camera,center,radius,controlsRef,size.width,size.height]);return null;
}

function AutomaticFocus({point,token,controlsRef,center}:{point:[number,number,number]|null;token:number;controlsRef:React.RefObject<OrbitControlsImpl>;center:THREE.Vector3}){
  const {camera}=useThree();
  useEffect(()=>{
    if(!point||!token||!controlsRef.current)return;
    const target=center.clone().lerp(new THREE.Vector3(...point),0.18);
    camera.position.add(target.clone().sub(controlsRef.current.target));
    controlsRef.current.target.copy(target);controlsRef.current.update();
  },[token,point,center,camera,controlsRef]);
  return null;
}

/** 保持FOV与建筑相机方向，只在窄视口后移相机，避免手机横向裁掉房间。 */
function ResponsiveFraming({center,camPos,radius,controlsRef,points,monitoring}: {
  center: THREE.Vector3;camPos: THREE.Vector3;radius:number;controlsRef:React.RefObject<OrbitControlsImpl>;points:THREE.Vector3[];monitoring?:boolean;
}) {
  const {camera,size,scene:threeScene}=useThree();
  useLayoutEffect(()=>{
    const aspect=size.width/Math.max(1,size.height);
    const framingScale=Math.max(1,1.5/aspect);
    camera.position.copy(camPos.clone().sub(center).multiplyScalar(framingScale).add(center));
    if(camera instanceof THREE.PerspectiveCamera){
      const framing=centeredRoomFraming(camera,camera.position,new THREE.Vector3(center.x,Math.min(center.y,3),center.z),points,size.width,size.height,monitoring?80:40);
      camera.position.copy(framing.position);
      // On smaller desktop screens, leave room for the wider temperature card on the left.
      const offsetX=!monitoring&&size.width>=1000&&size.width<=1450?-60:0;
      camera.setViewOffset(size.width,size.height,offsetX,framing.offsetY,size.width,size.height);
    }
    if(threeScene.fog instanceof THREE.Fog){threeScene.fog.near=radius*1.6*framingScale;threeScene.fog.far=radius*4.2*framingScale;}
    if (camera instanceof THREE.OrthographicCamera) {
      camera.zoom=Math.min(size.width,size.height)/(radius*1.1);
    }
    camera.lookAt(center.x,Math.min(center.y,3),center.z);
    camera.updateProjectionMatrix();
    controlsRef.current?.update();controlsRef.current?.saveState();
  },[camera,size.width,size.height,center,camPos,radius,controlsRef,threeScene,monitoring]);
  return null;
}

