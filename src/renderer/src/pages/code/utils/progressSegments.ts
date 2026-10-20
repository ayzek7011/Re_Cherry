// fork 缝（原创）：进度条**分段**的算术（纯函数，可单测）。
//
// 为什么单列一件：安装类长活的多数时长花在"执行"阶段（pip / npm / vite），这些阶段没有任何
// 诚实的百分比——单条进度条在那几分钟里只能装死（真机反馈：hermes 与 paper-agent 的进度条
// 不动）。分段的判据是"已完成 n 段"这个**事实**，段内可测时再按比例填。这套算术（1 起 vs 0 起、
// 越界钳制、整体百分比）出错的方式全是"看起来像在工作"的静默错误——所以它独立成件并被单测钉住。

import type { InstallStagePosition } from '@shared/types/installProgress'

/** 一段的填充：0..100 为确定值，null 表示该段不可测（画不确定态）。 */
export type SegmentFill = number | null

/**
 * 与载荷一致的段序钳制：段数与段序都可能来自主进程的越界值（版本错配、手改载荷），
 * 渲染层不因它画出负宽或空条——**有限值一律钳制回段内**（越界不是缺省的理由，
 * 单测钉住 `{index:-2,total:6}→{1,6}` 这一条）。NaN 防线：Math.max/min 对 NaN 透传
 * （NaN 会沿着 1 起的整条算术产出 NaN 百分比），非有限值按缺省段 `{1,1}` 处理。
 */
export function clampStage(stage: InstallStagePosition | undefined): { index: number; total: number } {
  const total = stage && Number.isFinite(stage.total) ? Math.max(1, Math.floor(stage.total)) : 1
  const index = stage && Number.isFinite(stage.index) ? Math.min(total, Math.max(1, Math.floor(stage.index))) : 1
  return { index, total }
}

/**
 * 每段的填充值：已完成的段满格（事实），当前段按 `currentPercent` 填或画不确定态，
 * 未到的段为 0。
 */
export function segmentFills(stage: InstallStagePosition | undefined, currentPercent: number | null): SegmentFill[] {
  const { index, total } = clampStage(stage)
  if (!stage) return [currentPercent]
  return Array.from({ length: total }, (_, i) => {
    if (i + 1 < index) return 100
    if (i + 1 === index) return currentPercent
    return 0
  })
}

/**
 * 整条进度条的百分比 = 已完成的段 + 当前段里可测的那部分；不确定段按 0 计（即"至少走到这里"）。
 *
 * 返回 null 只在**非分段**形态下出现（单条不确定态，无 aria-valuenow）；分段形态恒有确定值——
 * 因为"已走完 n-1 段"本身就是确定的事实。
 */
export function overallPercent(stage: InstallStagePosition | undefined, currentPercent: number | null): number | null {
  if (!stage) return currentPercent
  const { index, total } = clampStage(stage)
  return Math.round(((index - 1 + (currentPercent ?? 0) / 100) / total) * 100)
}
