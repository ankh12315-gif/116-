/**
 * FDS 体数据（.s3d）渲染 —— 与温度切片并列的第二种真实热场表达
 *
 * 数据来源：Smokeview `.s3d` -> `scripts/convert_s3d.py` 解压为原始体素字节
 * 存储：8bit 量化，**C 序**（i 最快、k 最慢）：`lin = (k*nj + j)*ni + i`
 * 量化：`T = baseC + byte × scaleC`（**PER_LSB**，scaleC = 2000/255 ≈ 7.8431）
 *
 * 三条不可妥协的要求：
 *
 * 1. **与切片同一套色标**（DESIGN_SYSTEM §3.2 硬性要求）。
 *    CPU 侧的 12 个色标锚点被送进 fragment shader 求色，**绝不逐帧归一化**，
 *    否则体数据与切片的颜色含义会漂移，两者不可比。量化参数也走 uniform，
 *    不在 shader 里硬编码。
 *
 * 2. **帧索引与切片独立，两套时间栅格必须分别取最近邻**。
 *    `.s3d` = 1000 帧，起于 t = 1.801s；`.sf` = 1001 帧，含 t = 0。
 *    两者**不可混用帧号**：这里按 `meta.frameTimesS` 独立查找最近邻帧，
 *    并通过 `onFrameInfo` 把该帧的真实时刻回报给 UI 标注。
 *
 * 3. **优雅降级**。体数据只有 HV-01-140MW 接入，其余 15 个工况
 *    `manifest === null` → 组件返回 null，不报错、不空白、不影响切片渲染。
 *
 * 渲染方式：`THREE.Data3DTexture`（`RedFormat`/`UnsignedByteType`）
 * + `ShaderMaterial`（GLSL3 `sampler3D`），世界空间单次散射光线步进，前置合成。
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Quantization, VolumeManifest, VolumeMeta } from '../types/domain';
import {
  TEMP_STOP_A,
  TEMP_STOP_COUNT,
  TEMP_STOP_RGB,
  TEMP_STOPS_C,
  fdsXbToThreeAabb,
  resolveScaleMode,
} from '../utils/coords';

/** 体数据当前帧信息，回报给 UI 做「两套时间栅格」标注 */
export interface VolumeFrameInfo {
  asset: string;
  meshIndex: number;
  /** 体数据侧真实帧时刻（s）——与切片帧时刻不同源，必须分别显示 */
  frameTimeS: number;
  frameIndex: number;
  /** 请求时刻与实际取帧的偏差（s），>0 说明做了最近邻取帧 */
  driftS: number;
  /** 该帧实测温域（℃） */
  dataMinC: number;
  dataMaxC: number;
}

/** 未接入体数据时的统一文案（其余 15 工况） */
export const VOLUME_UNAVAILABLE_LABEL = '该工况未接入体数据';

interface Props {
  /** 当前工况的体数据清单；null = 该工况未接入体数据 → 渲染 null */
  manifest: VolumeManifest | null;
  /** 已加载的体数据二进制（按 asset 索引；同时只有一个） */
  volumeData: Record<string, Uint8Array>;
  /** 是否加载中 */
  loading: boolean;
  /** 当前时刻（s，含未来偏移由调用方算好） */
  timeS: number;
  visible: boolean;
  /** 全局不透明度倍率 */
  opacity?: number;
  onFrameInfo?: (info: VolumeFrameInfo) => void;
}

export default function ThermalVolume({
  manifest,
  volumeData,
  loading,
  timeS,
  visible,
  opacity = 1,
  onFrameInfo,
}: Props) {
  // 优雅降级：无清单（其余 15 工况）/ 不可见 → 不渲染任何东西，不报错
  if (!visible || !manifest || manifest.volumes.length === 0) return null;

  const meta = manifest.volumes.find((v) => volumeData[v.asset]) ?? manifest.volumes[0];
  if (!meta) return null;

  return (
    <VolumeMesh
      key={meta.asset}
      meta={meta}
      bin={volumeData[meta.asset] ?? null}
      loading={loading}
      timeS={timeS}
      opacity={opacity}
      onFrameInfo={onFrameInfo}
    />
  );
}

function VolumeMesh({
  meta,
  bin,
  loading,
  timeS,
  opacity,
  onFrameInfo,
}: {
  meta: VolumeMeta;
  bin: Uint8Array | null;
  loading: boolean;
  timeS: number;
  opacity: number;
  onFrameInfo?: (i: VolumeFrameInfo) => void;
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  /* ---- 帧索引：体数据自己的时间栅格，与切片完全独立 ---- */
  const frame = useMemo(() => nearestFrame(meta, timeS), [meta, timeS]);

  const frameSize = meta.ni * meta.nj * meta.nk;

  /* ---- 体素纹理：只上传当前帧（整卷16MB× 帧切换重传无意义） ---- */
  const texture = useMemo(() => {
    if (!bin) return null;
    const start = frame.index * frameSize;
    if (start + frameSize > bin.length) return null;
    // 复制成独立 ArrayBuffer：three 的Data3DTexture 类型要求
    // ArrayBufferView<ArrayBuffer>（不能是 SharedArrayBuffer 视图），
    // 且 subarray 会让纹理持有整个 16MB 大数组的引用。
    const voxels = new Uint8Array(frameSize);
    voxels.set(bin.subarray(start, start + frameSize));
    const tex = new THREE.Data3DTexture(voxels, meta.ni, meta.nj, meta.nk);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }, [bin, meta.ni, meta.nj, meta.nk, frame.index, frameSize]);

  /* ---- 量化参数（禁止在 shader 里硬编码） ---- */
  const quant = useMemo(() => volumeQuant(meta.quantization), [meta.quantization]);

  /* ---- 本帧实测温域（回报 UI，不参与取色） ---- */
  const frameStats = useMemo(() => {
    if (!bin) return { min: NaN, max: NaN };
    const start = frame.index * frameSize;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < frameSize; i++) {
      const t = quant.baseC + bin[start + i] * quant.scaleC;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    return { min, max };
  }, [bin, frame.index, frameSize, quant.baseC, quant.scaleC]);

  useEffect(() => {
    onFrameInfo?.({
      asset: meta.asset,
      meshIndex: meta.meshIndex,
      frameTimeS: frame.timeS,
      frameIndex: frame.index,
      driftS: Math.abs(timeS - frame.timeS),
      dataMinC: frameStats.min,
      dataMaxC: frameStats.max,
    });
  }, [
    onFrameInfo,
    meta.asset,
    meta.meshIndex,
    frame.timeS,
    frame.index,
    timeS,
    frameStats.min,
    frameStats.max,
  ]);

  useEffect(() => {
    return () => texture?.dispose();
  }, [texture]);

  /* ---- 网格盒体：由 meshXb（FDS XB）导出 Three AABB ---- */
  const box = useMemo(() => {
    const { min, max, center, size } = fdsXbToThreeAabb(meta.meshXb);
    return { min, max, center, size };
  }, [meta.meshXb]);

  const uniforms = useMemo(
    () => ({
      uVol: { value: texture },
      uBoxMin: { value: new THREE.Vector3(box.min[0], box.min[1], box.min[2]) },
      uBoxMax: { value: new THREE.Vector3(box.max[0], box.max[1], box.max[2]) },
      uBaseC: { value: quant.baseC },
      uScaleC: { value: quant.scaleC },
      uTempStops: { value: TEMP_STOPS_C.slice() },
      uStopColors: {
        value: TEMP_STOP_RGB.map((c) => new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255)),
      },
      uStopAlphas: { value: TEMP_STOP_A.slice() },
      uSteps: { value: 160 },
      uDensity: { value: 22.0 },
      uOpacity: { value: 0.92 * opacity },
      uLoaded: { value: texture ? 1 : 0 },
    }),
    // box 只在几何变化时重建；texture / opacity 走下面的 uniform 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [box.min[0], box.min[1], box.min[2], box.max[0], box.max[1], box.max[2], quant.baseC, quant.scaleC, opacity],
  );

  // 纹理与不透明度单独同步，避免因帧切换重建整个 shader program
  useEffect(() => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uVol.value = texture;
    m.uniforms.uLoaded.value = texture ? 1 : 0;
    m.uniforms.uOpacity.value = 0.92 * opacity;
    m.uniformsNeedUpdate = true;
  }, [texture, opacity]);

  if (box.size[0] <= 0 || box.size[1] <= 0 || box.size[2] <= 0) return null;

  return (
    <mesh position={[box.center[0], box.center[1], box.center[2]]} renderOrder={480}>
      <boxGeometry
        args={[box.size[0], box.size[1], box.size[2]]}
        onUpdate={(g) => {
          // 体渲染用 BackSide + 世界空间求交，几何只需落在正确位置与尺寸
          g.computeBoundingSphere();
        }}
      />
      <shaderMaterial
        ref={matRef}
        args={[
          {
            uniforms,
            vertexShader: VOLUME_VERT,
            fragmentShader: VOLUME_FRAG,
            glslVersion: THREE.GLSL3,
          },
        ]}
        transparent
        depthWrite={false}
        depthTest
        side={THREE.BackSide}
        toneMapped={false}
      />
      {/* 无体素时（例如仍在下载）不显示任何热场，避免误读为「该处温度低」 */}
      <group userData={{ volumeLoading: loading, volumeAsset: meta.asset, volumeReady: !!texture }} />
    </mesh>
  );
}

/**
 * 体数据量化参数（`.s3d` 的 `scaleC` 是 PER_LSB 语义，由 `resolveScaleMode` 按量级判别）。
 *
 * ⚠️ 2026-10-08：原实现是 `resolveScaleMode(q, true)` —— 硬编码 `isV2Asset=true`。
 * 该二参判据（`gridDims` 存在即 PER_LSB）已被实测证伪并从 `resolveScaleMode` 中删除，
 * 因为 `fix_slice_dims.py` 给全部 16 个工况都写了 `gridDims`。
 * 现只传量化参数，由主判据（`scaleC` 量级）自行判别：
 * 体数据 scaleC=7.8431 < 100 → PER_LSB，与 `.s3d` 的真实语义一致。
 */
function volumeQuant(q: Quantization): { baseC: number; scaleC: number } {
  const mode = resolveScaleMode(q);
  // PER_LSB：T = baseC + byte*scaleC；SPAN：T = baseC + (byte/255)*scaleC
  return { baseC: q.baseC, scaleC: mode === 'PER_LSB' ? q.scaleC : q.scaleC / 255 };
}

/**
 * 按体数据自己的 frameTimesS 取最近邻帧。
 *
 * ⚠️ 绝不复用切片的帧号：`.s3d` 1000 帧起于 t=1.801s，`.sf` 1001 帧含 t=0。
 * 若混用，切片第 0 帧（t=0）会取到体数据的第 0 帧（t=1.801s），
 * 界面会同时显示两个不同来源的时刻却声称是同一时刻。
 */
function nearestFrame(meta: VolumeMeta, timeS: number): { index: number; timeS: number } {
  const times = meta.frameTimesS;
  if (times.length === 0) return { index: 0, timeS: meta.frameTimeStartS };
  if (timeS <= times[0]) return { index: 0, timeS: times[0] };
  const last = times.length - 1;
  if (timeS >= times[last]) return { index: last, timeS: times[last] };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= timeS) lo = mid;
    else hi = mid;
  }
  // 取最近的邻帧（不外推、不插值：插值会产生非物理的中间热场）
  return timeS - times[lo] <= times[hi] - timeS
    ? { index: lo, timeS: times[lo] }
    : { index: hi, timeS: times[hi] };
}

/* ------------------------------ 着色器 ------------------------------ */

/**
 * 世界空间单次散射光线步进。
 *
 * 顶点着色器输出片元世界坐标；片元用 three 注入的 `cameraPosition`
 * 与之构成视线方向，在世界空间与 AABB 求交后逐体素采样 `sampler3D`。
 * mesh 使用 `side: BackSide`，故每个像素的视线恰好穿过整个盒子一次。
 */
export const VOLUME_VERT = /* glsl */ `
out vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const VOLUME_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform sampler3D uVol;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform float uBaseC;
uniform float uScaleC;
uniform float uTempStops[${TEMP_STOP_COUNT}];
uniform vec3  uStopColors[${TEMP_STOP_COUNT}];
uniform float uStopAlphas[${TEMP_STOP_COUNT}];
uniform int   uSteps;
uniform float uDensity;
uniform float uOpacity;
uniform int   uLoaded;

in vec3 vWorld;
out vec4 fragColor;

/**
 * 温度 -> RGB / alpha。
 * 锚点与 CPU 侧 utils/coords.ts 的 TEMP_STOPS / TEMP_ALPHA 完全一致，
 * 保证体渲染与切片的颜色含义可比（不可逐帧归一化）。
 */
vec4 tempToColor(float c) {
  int last = ${TEMP_STOP_COUNT} - 1;
  if (c <= uTempStops[0]) return vec4(uStopColors[0], uStopAlphas[0]);
  if (c >= uTempStops[last]) return vec4(uStopColors[last], uStopAlphas[last]);
  for (int i = 0; i < last; i++) {
    float t0 = uTempStops[i];
    float t1 = uTempStops[i + 1];
    if (c >= t0 && c <= t1) {
      float f = (c - t0) / max(t1 - t0, 1e-6);
      return vec4(
        mix(uStopColors[i], uStopColors[i + 1], f),
        mix(uStopAlphas[i], uStopAlphas[i + 1], f)
      );
    }
  }
  return vec4(uStopColors[last], uStopAlphas[last]);
}

bool intersectBox(vec3 ro, vec3 rd, out float t0, out float t1) {
  // 平行于某轴时 1/rd = inf；若此时 ro 恰好落在该轴的面上，(min-ro)*inf = 0*inf = NaN，
  // 会沿整条射线传播成 NaN → 整个像素变黑。用绝对值下限把分母推离 0。
  vec3 safeRd = vec3(
    abs(rd.x) < 1e-8 ? (rd.x < 0.0 ? -1e-8 : 1e-8) : rd.x,
    abs(rd.y) < 1e-8 ? (rd.y < 0.0 ? -1e-8 : 1e-8) : rd.y,
    abs(rd.z) < 1e-8 ? (rd.z < 0.0 ? -1e-8 : 1e-8) : rd.z
  );
  vec3 inv = 1.0 / safeRd;
  vec3 a = (uBoxMin - ro) * inv;
  vec3 b = (uBoxMax - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z);
  t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}

void main() {
  if (uLoaded == 0) discard;

  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);

  float t0, t1;
  if (!intersectBox(ro, rd, t0, t1)) discard;
  t0 = max(t0, 0.0);
  if (t1 <= t0) discard;

  float dt = (t1 - t0) / float(uSteps);
  if (dt <= 0.0) discard;

  vec4 acc = vec4(0.0);
  float t = t0 + dt * 0.5;

  for (int i = 0; i < 256; i++) {
    if (i >= uSteps) break;
    vec3 p = ro + rd * t;
    vec3 uvw = (p - uBoxMin) / (uBoxMax - uBoxMin);
    float q = texture(uVol, uvw).r;
    // 量化解码参数来自 uniform（PER_LSB: baseC + byte*scaleC），不在此硬编码
    float temp = uBaseC + q * uScaleC;
    vec4 s = tempToColor(temp);
    // 20℃ 的 alpha = 0 → 常温体素完全不着色（与切片同一语义）
    float a = s.a * uDensity * dt * uOpacity;
    acc.rgb += (1.0 - acc.a) * s.rgb * a;
    acc.a   += (1.0 - acc.a) * a;
    if (acc.a > 0.97) break;
    t += dt;
  }

  if (acc.a <= 0.002) discard;
  fragColor = vec4(acc.rgb / max(acc.a, 1e-5), acc.a);
}
`;