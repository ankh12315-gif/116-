/**
 * 底部悬浮工具条容器（DESIGN_SYSTEM §4.3）
 *
 * 只负责布局：时间轴一行 + 工具 chip 一行。
 * 时间轴由外部通过 `timeline` prop 注入，避免本组件耦合其内部实现。
 */

import type { ReactNode } from 'react';

interface Props {
  /** 时间轴（通常是 <Timeline />） */
  timeline: ReactNode;
  /** 工具行内容 */
  children?: ReactNode;
}

export default function BottomDock({ timeline, children }: Props) {
  return (
    <div className="dock">
      {timeline}
      {children ? <div className="dock__row">{children}</div> : null}
    </div>
  );
}