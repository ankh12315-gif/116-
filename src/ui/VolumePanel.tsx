/**
 * 体数据（.s3d）控制与状态面板
 *
 * 承担四项职责：
 *  1. 独立于切片的显隐开关（两者可同时开/关，色标一致故视觉可比）
 *  2. mesh 选择：一次只加载并显示当前 mesh 的一个（16MB/个，不能一次全 load）
 *  3. **优雅降级**：该工况无 `volume/manifest.json` 时显示「该工况未接入体数据」，
 *     不报错、不空白、不显示任何假的温度信息
 *  4. **两套时间栅格分别标注**：体数据帧时刻与切片帧时刻来源不同、栅格不同，
 *     必须同时显示，绝不把两者说成同一时刻
 */

import { useFireStore } from '../store/useFireStore';
import { VOLUME_UNAVAILABLE_LABEL } from '../scene/ThermalVolume';
import type { VolumeFrameInfo } from '../scene/ThermalVolume';
import { formatNumber } from '../utils/format';

interface Props {
  frameInfo: VolumeFrameInfo | null;
}

export default function VolumePanel({ frameInfo }: Props) {
  const manifest = useFireStore((s) => s.volumeManifest);
  const loading = useFireStore((s) => s.volumeLoading);
  const showVolume = useFireStore((s) => s.showVolume);
  const activeMesh = useFireStore((s) => s.activeVolumeMeshIndex);
  const toggleVolume = useFireStore((s) => s.toggleVolume);
  const selectVolumeMesh = useFireStore((s) => s.selectVolumeMesh);
  const slices = useFireStore((s) => s.slices);

  // 优雅降级：无体数据清单 = 该工况未接入
  if (!manifest) {
    return (
      <section className="panel" aria-label="体数据" style={{ padding: 12 }}>
        <h2 className="panel__title" style={{ margin: '0 0 4px' }}>
          体数据
        </h2>
        <div className="notice notice--info" style={{ fontSize: 10.5 }}>
          {VOLUME_UNAVAILABLE_LABEL}
          <br />
          仅 HV-01-140MW 已转换 <code>.s3d</code> 体数据；当前工况仅接入温度切片
          （{slices.length > 0 ? `${slices.length} 片` : '0 片'}）。
        </div>
      </section>
    );
  }

  const sliceFrameCount = slices[0]?.frameCount ?? null;
  const sliceStartS = slices[0]?.frameTimesS?.[0] ?? null;
  const volStartS = manifest.volumes[0]?.frameTimeStartS ?? null;

  return (
    <section className="panel" aria-label="体数据" style={{ padding: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <h2 className="panel__title" style={{ margin: 0 }}>
          体数据
        </h2>
        <span className="badge badge--fds">FDS SIMULATED</span>
      </div>

      {/* 显隐开关：与切片独立 */}
      <button
        type="button"
        className={`btn btn--sm${showVolume ? ' btn--primary' : ''}`}
        aria-pressed={showVolume}
        onClick={() => void toggleVolume()}
        style={{ width: '100%' }}
        title="体数据与切片共用同一套色标，可同时开启做视觉对照"
      >
        {showVolume ? '◉ 体数据已开启' : '○ 体数据已关闭'}
      </button>

      {/* mesh 选择：一次只加载一个 */}
      <div
        style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(manifest.volumes.length, 3)}, 1fr)`, gap: 3, marginTop: 6 }}
        role="radiogroup"
        aria-label="体数据 mesh 选择"
      >
        {manifest.volumes.map((v) => (
          <button
            key={v.asset}
            type="button"
            role="radio"
            aria-checked={activeMesh === v.meshIndex}
            className={`chip${activeMesh === v.meshIndex ? ' is-active' : ''}`}
            style={{ justifyContent: 'center' }}
            onClick={() => void selectVolumeMesh(v.meshIndex)}
            title={`mesh ${v.meshIndex} · ${v.ni}×${v.nj}×${v.nk} · ${(v.binBytes / 1048576).toFixed(1)} MB · 实测 ${formatNumber(v.dataMinC, 0)}–${formatNumber(v.dataMaxC, 1)} ℃`}
          >
            M{v.meshIndex}
            <span className="chip__tag">{(v.binBytes / 1048576).toFixed(0)}MB</span>
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10.5 }}>
          <span className="spinner" aria-hidden="true" />
          <span style={{ color: 'var(--c-text-2)' }}>体数据加载中…</span>
        </div>
      )}

      {/*
       * 两套时间栅格**必须分别标注**：
       *   体数据 .s3d —— 1000 帧，起于 t=1.80 s（不含 t=0）
       *   切片   .sf  —— 1001 帧，含 t=0
       * 二者不可混用帧号（若混用，切片 t=0 会显示体数据 t=1.80 s 的热场）。
       */}
      <div
        style={{
          marginTop: 8,
          paddingTop: 6,
          borderTop: '1px solid var(--c-divider)',
          fontSize: 9.5,
          lineHeight: 1.55,
          color: 'var(--c-text-2)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <div>体数据栅格：{formatNumber(manifest.volumes[0]?.frameCount ?? 0, 0)} 帧，起于 t={formatNumber(volStartS, 2)} s</div>
        <div>
          切片栅格：
          {sliceFrameCount !== null ? `${formatNumber(sliceFrameCount, 0)} 帧` : '—'}
          {sliceStartS !== null ? `，含 t=${formatNumber(sliceStartS, 1)} s` : ''}
        </div>
        <div style={{ color: 'var(--c-text-3)' }}>两套栅格不同帧，各自取最近邻帧，不互相换算</div>
      </div>

      {/* 当前体数据帧信息 */}
      {showVolume && frameInfo && (
        <div
          style={{
            marginTop: 5,
            fontSize: 9.5,
            lineHeight: 1.55,
            color: 'var(--c-text-2)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <div>
            当前体数据帧 #{formatNumber(frameInfo.frameIndex, 0)} @ t=
            {formatNumber(frameInfo.frameTimeS, 2)} s
            {frameInfo.driftS > 1e-3 && (
              <span style={{ color: 'var(--c-text-3)' }}> （Δ{formatNumber(frameInfo.driftS, 2)} s）</span>
            )}
          </div>
          <div>
            本帧实测 {formatNumber(frameInfo.dataMinC, 1)} – {formatNumber(frameInfo.dataMaxC, 1)} ℃
          </div>
        </div>
      )}

      <p style={{ margin: '6px 0 0', fontSize: 9.5, lineHeight: 1.5, color: 'var(--c-text-3)' }}>
        体数据与切片共用同一色标定义域，颜色可跨两者比较；
        但帧栅格不同，同一时刻可能取到不同帧，已分别标注。
      </p>
    </section>
  );
}