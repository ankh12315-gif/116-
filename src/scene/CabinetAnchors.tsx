/**
 * 起火柜锚点：真实 FDS VENT SURF_ID='burner' 的几何中心
 *
 * 重要：这是**火源面中心**，不是柜体外壳包围盒。
 * 源 FDS 无柜体语义字段，外壳未核验，UI 必须标注。
 */

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Cabinet, VoltageZone } from '../types/domain';
import { fdsToThree } from '../utils/coords';

interface Props {
  cabinets: Cabinet[];
  selectedId: string | null;
  zoneFilter: 'ALL' | 'HIGH' | 'LOW';
  showLabels: boolean;
  alarmLevel: Record<string, 'NORMAL' | 'TEMPERATURE_WARNING' | 'FIRE_ALARM' | 'UNKNOWN'>;
  onSelect: (id: string) => void;
}

const ZONE_COLOR: Record<VoltageZone, string> = {
  HIGH: '#3f6d8c',
  LOW: '#5d7a5e',
};

const LEVEL_COLOR = {
  NORMAL: '#7e8b86',
  TEMPERATURE_WARNING: '#d9902f',
  FIRE_ALARM: '#d6432f',
  UNKNOWN: '#9aa5a0',
} as const;

export default function CabinetAnchors({
  cabinets,
  selectedId,
  zoneFilter,
  showLabels,
  alarmLevel,
  onSelect,
}: Props) {
  return (
    <group>
      {cabinets.filter(c=>c.id===selectedId).map((c) => {
        const dim = zoneFilter !== 'ALL' && zoneFilter !== c.zone;
        return (
          <Anchor
            key={c.id}
            cabinet={c}
            selected={selectedId === c.id}
            dimmed={dim}
            showLabel={showLabels}
            level={alarmLevel[c.id] ?? 'NORMAL'}
            onSelect={onSelect}
          />
        );
      })}
    </group>
  );
}

function Anchor({
  cabinet,
  selected,
  dimmed,
  showLabel,
  level,
  onSelect,
}: {
  cabinet: Cabinet;
  selected: boolean;
  dimmed: boolean;
  showLabel: boolean;
  level: 'NORMAL' | 'TEMPERATURE_WARNING' | 'FIRE_ALARM' | 'UNKNOWN';
  onSelect: (id: string) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const pos = useMemo(
    () => fdsToThree(...cabinet.burnerCenterFdsM),
    [cabinet.burnerCenterFdsM],
  );
  const baseColor = LEVEL_COLOR[level] ?? ZONE_COLOR[cabinet.zone];

  useFrame(({ clock }) => {
    if (!ringRef.current) return;
    const t = clock.getElapsedTime();
    const isAlarm = level === 'FIRE_ALARM';
    const s = isAlarm ? 1 + Math.sin(t * 3.4) * 0.22 : 1 + Math.sin(t * 1.5) * 0.05;
    ringRef.current.scale.setScalar(s);
    const mat = ringRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = isAlarm ? 0.75 + Math.sin(t * 3.4) * 0.2 : selected ? 0.62 : 0.3;
  });

  const opacity = dimmed ? 0.18 : 1;

  return (
    <group
      ref={groupRef}
      position={pos}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(cabinet.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      {/* 拾取球（不可见，扩大点击热区） */}
      <mesh visible={false}>
        <sphereGeometry args={[0.55, 12, 8]} />
      </mesh>

      {/* 地面投影环 */}
      <mesh
        ref={ringRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -pos[1] + 0.02, 0]}
        renderOrder={998}
      >
        <ringGeometry args={[0.34, 0.44, 32]} />
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* 竖直标记杆 + 顶端球 */}
      <mesh position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.022, 0.022, 1.1, 8]} />
        <meshBasicMaterial color={baseColor} transparent opacity={opacity * 0.75} />
      </mesh>
      <mesh position={[0, 1.16, 0]} renderOrder={999}>
        <sphereGeometry args={[selected ? 0.17 : 0.13, 20, 14]} />
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={opacity}
          depthTest={false}
        />
      </mesh>

      {/* 选中态：竖直光柱 */}
      {selected && (
        <mesh position={[0, 1.6, 0]} renderOrder={997}>
          <cylinderGeometry args={[0.045, 0.09, 3.0, 12, 1, true]} />
          <meshBasicMaterial
            color={baseColor}
            transparent
            opacity={0.13}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* HTML 标签 */}
      {(showLabel || selected) && !dimmed && (
        <Html
          position={[0, 1.42, 0]}
          center
          distanceFactor={undefined}
          zIndexRange={[20, 0]}
          style={{ pointerEvents: 'auto' }}
        >
          <span
            className={`anchor-label${selected ? ' is-selected' : ''}${
              level === 'FIRE_ALARM' ? ' is-alarm' : ''
            }${level === 'TEMPERATURE_WARNING' ? ' is-warning' : ''}`}
            aria-label={`已定位起火位置 ${cabinet.id}`}
          >
            <span className="anchor-label__zone">
              起火位置
            </span>
            <span className="anchor-label__id">{cabinet.id}</span>
          </span>
        </Html>
      )}
    </group>
  );
}
