/**
 * FDS 温度切片渲染（真实数据）
 *
 * 数据来源：Smokeview .sf 二进制 -> scripts/convert_fds_outputs.py 量化为 8bit
 * 显示：把温度场用 Canvas 纹理贴到三维平面上的 DataTexture
 *
 * 严格原则（docs/05 §4）：
 *  - 只渲染真实 FDS 输出，不做任何人为扩散特效
 *  - 无数据时不渲染热云图，显示缺失提示
 *  - 20℃ 常温在白色建筑上几乎不可见（色标设计）
 *  - 帧间不做插值，只显示真实存在的帧
 */

import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import type { SliceMeta } from '../types/domain';
import {
  NO_DATA_COLOR,
  dequantizeTemp,
  fdsToThree,
  quantSpecFromSlice,
  temperatureToColor,
  warnOnScaleMismatch,
} from '../utils/coords';
import {visualization} from '../config/visualization';
import {visibleHeatAlpha} from '../utils/heatPresentation';
import {findSliceFrameIndex} from '../data/scenarioProvider';

/** 单帧切片实测温域回报（供 UI 核查，不参与取色） */
export interface SliceFrameStats {
  asset: string;
  frameIndex: number;
  dataMinC: number;
  dataMaxC: number;
}

interface Props {
  slices: SliceMeta[];
  sliceData: Record<string, Uint8Array|Float32Array>;
  plane: 'PBZ' | 'PBX' | 'PBY' | 'ALL';
  frameIndex: number;
  timeS?:number;
  opacity: number;
  visible: boolean;
  onFrameStats?: (s: SliceFrameStats) => void;
}

/**
 * 把量化数据转换为 RGBA 纹理像素。
 * 数据排列：Smokeview slice 为 i 变化最快、j 变化次之（行主序，j 为行）
 *
 *⚠️ 量化参数**必须来自 sliceMeta.quantization**（含 scaleC 语义判别），
 *  绝不能硬编码 20/780：
 *   - 15 个工况：base=20, scale=780, SPAN →域 20–800 ℃
 *   - HV-01-140MW：base=20, scale=2000/255, PER_LSB → 域 20–2020 ℃
 *  对 140MW 套用 780 会把实测 1133 ℃画成 24 ℃（把火场画成室温 = 伪造数据）。
 *
 * 色标本身（TEMP_STOPS）**跨工况固定不归一化**（DESIGN_SYSTEM §3.2 硬性要求），
 * 保证颜色含义可比；动态的只是「解码域」与「图例显示的域上限」。
 */
function buildTexture(
  meta: SliceMeta,
  bin: Uint8Array|Float32Array,
  frameIndex: number,
): { texture: THREE.DataTexture; stats: { min: number; max: number } } {
  const { ni, nj } = meta;
  const spec = quantSpecFromSlice(meta);
  const frameSize = ni * nj;
  const start = frameIndex * frameSize;
  const pixels = new Uint8Array(frameSize * 4);
  let minT = Infinity;
  let maxT = -Infinity;

  for (let p = 0; p < frameSize; p++) {
    const raw = start + p;
    const q = raw < bin.length ? bin[raw] : undefined;
    if (q === undefined) {
      // 帧越界/数据缺失 → NO_DATA（中性灰 + 斜纹），绝不填 0 当作 20℃ 低值
      writeNoData(pixels, p);
      continue;
    }
    const t = bin instanceof Float32Array?q:dequantizeTemp(q, spec.baseC, spec.scaleC, spec.mode);
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    const [r, g, b] = temperatureToColor(t,visualization.palette);
    const o = p * 4;
    pixels[o] = r;
    pixels[o + 1] = g;
    pixels[o + 2] = b;
    // 常温区域完全透明，避免整片房间被染色
    pixels[o + 3] = Math.round(visibleHeatAlpha(t) * 255);
  }

  const tex = new THREE.DataTexture(pixels, ni, nj, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  return {
    texture: tex,
    stats: {
      min: Number.isFinite(minT) ? minT : NaN,
      max: Number.isFinite(maxT) ? maxT : NaN,
    },
  };
}

/**
 * 无数据像素：中性灰 + 极低alpha。
 * 与 20℃（有数据的极低值，alpha=0、色带左端）在语义上严格区分 ——
 * 前者是「没有值」，后者是「有值且很低温」。
 */
function writeNoData(pixels: Uint8Array, p: number): void {
  const o = p * 4;
  pixels[o] = NO_DATA_COLOR[0];
  pixels[o + 1] = NO_DATA_COLOR[1];
  pixels[o + 2] = NO_DATA_COLOR[2];
  // alpha 极低：既能被辨认为「覆盖了但无数据」，又不会形成灰色实体遮挡几何
  pixels[o + 3] = 26;
}

export default function ThermalSlices({
  slices,
  sliceData,
  plane,
  frameIndex,
  timeS,
  opacity,
  visible,
  onFrameStats,
}: Props) {
  const groupRef = useRef<THREE.Group>(null);

  const targets = useMemo(
    () => slices.filter((s) => (plane==='ALL'||s.plane === plane) && sliceData[s.asset]),
    [slices, sliceData, plane],
  );

  if (!visible || targets.length === 0) return null;

  return (
    <group ref={groupRef}>
      {targets.map((meta) => (
        <SlicePlaneMesh
          key={meta.asset}
          meta={meta}
          bin={sliceData[meta.asset]}
          frameIndex={timeS===undefined?Math.min(frameIndex, meta.frameCount - 1):findSliceFrameIndex(meta,timeS)?.index??0}
          opacity={opacity}
          onFrameStats={onFrameStats}
        />
      ))}
    </group>
  );
}

function SlicePlaneMesh({
  meta,
  bin,
  frameIndex,
  opacity,
  onFrameStats,
}: {
  meta: SliceMeta;
  bin: Uint8Array|Float32Array;
  frameIndex: number;
  opacity: number;
  onFrameStats?: (s: SliceFrameStats) => void;
}) {
  const matRef = useRef<THREE.MeshBasicMaterial>(null);

  const { texture, stats } = useMemo(
    () => buildTexture(meta, bin, frameIndex),
    [meta, bin, frameIndex],
  );

  // 当前帧真实温域回报给UI（图例/状态栏），使「量化域」与「本帧实测量程」都可核查。
  // 量化域上限仍由 sliceQuantDomain(meta) 决定，本处只披露实测值，不改变任何取色。
  useEffect(() => {
    onFrameStats?.({
      asset: meta.asset,
      frameIndex,
      dataMinC: stats.min,
      dataMaxC: stats.max,
    });
  }, [onFrameStats, meta.asset, frameIndex, stats.min, stats.max]);

  /**
   * 残差自检（每个切片只跑一次）：用**整个 .bin** 的最大 byte 与 manifest 的
   * `dataMaxC` 比对，判别 `scaleMode` 判别是否可信。
   *
   * ⚠️ 必须用全量 byte 而非当前帧：单帧可能恰好没烧到最高温，
   * 用帧内最大值会误报。实测 140MW 的 `dataMaxC=940.72℃` 对应 byte=255，
   * 若按 SPAN 解码上限只有 27.84℃ —— 差 900℃ 以上，只能靠全量 byte 暴露。
   *
   * 纯诊断：不修改数据、不改变取色，仅在不自洽时 console.warn。
   */
  useEffect(() => {
    if (!bin || bin.length === 0 || bin instanceof Float32Array) return;
    let byteMax = 0;
    for (let i = 0; i < bin.length; i++) {
      if (bin[i] > byteMax) byteMax = bin[i];
    }
    warnOnScaleMismatch(meta, byteMax);
  }, [meta, bin]);

  useEffect(() => {
    return () => texture.dispose();
  }, [texture]);

  // 计算平面的 Three 坐标位置与朝向
  const { position, rotation, width, height } = useMemo(() => {
    const [u0, u1] = meta.uRangeM;
    const [v0, v1] = meta.vRangeM;
    const uc = (u0 + u1) / 2;
    const vc = (v0 + v1) / 2;
    const w = Math.abs(u1 - u0);
    const h = Math.abs(v1 - v0);

    if (meta.plane === 'PBZ') {
      // FDS z 常量 -> Three y 常量；u=x, v=y -> Three (x, z=-y)
      return {
        position: fdsToThree(uc, vc, meta.planeCoordM),
        rotation: [-Math.PI / 2, 0, 0] as [number, number, number],
        width: w,
        height: h,
      };
    }
    if (meta.plane === 'PBY') {
      // FDS y 常量 -> Three z 常量；u=x, v=z
      return {
        position: fdsToThree(uc, meta.planeCoordM, vc),
        rotation: [0, 0, 0] as [number, number, number],
        width: w,
        height: h,
      };
    }
    // PBX: FDS x 常量 -> Three x 常量；u=y, v=z
    return {
      position: fdsToThree(meta.planeCoordM, uc, vc),
      rotation: [0, Math.PI / 2, 0] as [number, number, number],
      width: w,
      height: h,
    };
  }, [meta]);

  // 纹理方向修正：Three 的 PlaneGeometry UV 原点在左下，
  // 需根据 FDS 轴向翻转，保证温度场空间位置正确
  const texRepeat = useMemo(() => {
    const tex = texture.clone();
    tex.needsUpdate = true;
    // 数组i/u最快，j/v次之；Three平面变换已完成坐标方向映射，不应再镜像。
    tex.flipY = false;
    return tex;
  }, [texture, meta.plane]);

  useEffect(() => {
    return () => texRepeat.dispose();
  }, [texRepeat]);

  if (width <= 0 || height <= 0) return null;

  return (
    <mesh position={position} rotation={rotation} renderOrder={500}>
      <planeGeometry args={[width, height, 1, 1]} />
      <meshBasicMaterial
        ref={matRef}
        map={texRepeat}
        transparent
        opacity={opacity}
        side={THREE.DoubleSide}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
    </mesh>
  );
}
