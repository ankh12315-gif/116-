/**
 * 温度切片的边框线框（真实切片的物理范围）
 * 用于在三维空间中界定热力面的位置，即使数据缺失也能显示平面位置。
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { SliceMeta } from '../types/domain';

interface Props {
  slices: SliceMeta[];
  sliceData: Record<string, Uint8Array>;
  plane: 'PBZ' | 'PBX' | 'PBY';
}

export default function SliceFrameOutline({ slices, sliceData, plane }: Props) {
  const geometries = useMemo(() => {
    return slices.map((s) => {
      const [u0, u1] = s.uRangeM;
      const [v0, v1] = s.vRangeM;
      const uc = (u0 + u1) / 2;
      const vc = (v0 + v1) / 2;
      const w = Math.abs(u1 - u0);
      const h = Math.abs(v1 - v0);
      if (w <= 0 || h <= 0) return null;

      let position: [number, number, number];
      let rotation: [number, number, number];
      if (plane === 'PBZ') {
        position = [uc, s.planeCoordM, -vc];
        rotation = [-Math.PI / 2, 0, 0];
      } else if (plane === 'PBY') {
        position = [uc, vc, -s.planeCoordM];
        rotation = [0, 0, 0];
      } else {
        position = [s.planeCoordM, vc, -uc];
        rotation = [0, Math.PI / 2, 0];
      }

      const geo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h));
      return {
        key: s.asset,
        geo,
        position,
        rotation,
        hasData: Boolean(sliceData[s.asset]),
      };
    });
  }, [slices, sliceData, plane]);

  return (
    <group>
      {geometries.map((g) =>
        g ? (
          <lineSegments
            key={g.key}
            geometry={g.geo}
            position={g.position}
            rotation={g.rotation}
            renderOrder={501}
          >
            <lineBasicMaterial
              color={g.hasData ? '#8c2c4c' : '#9b968c'}
              transparent
              opacity={g.hasData ? 0.5 : 0.28}
              depthWrite={false}
            />
          </lineSegments>
        ) : null,
      )}
    </group>
  );
}