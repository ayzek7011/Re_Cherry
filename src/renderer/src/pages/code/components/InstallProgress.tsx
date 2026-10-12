// fork 缝（原创）：受管工具安装进度的**标准元素**。
//
// 它把"安装进度"这件事收成一处，任何要展示安装进度的界面（三个工具的版本卡，未来的第四个
// 工具、设置页的依赖面板、小程序卡片……）都复用它，而不是各自复制 markup：
// - 文案由共享词汇表 `InstallProgressStep` 决定（键表 STEP_LABEL_KEYS 显式列出
//   `code.install_progress.<step>`，漏步骤是编译错误，键为字面量走静态键检），
// - **按阶段分段**（stage = 第 n 步 / 共 m 步）：已完成的段是事实，当前段里只有能算的才给
//   比例。这条是"进度条正常工作"的判据本身——安装的多数时长花在 pip/npm/vite 这类没有诚实
//   百分比的执行阶段，单条进度条在那几分钟里只能装死（真机反馈：hermes 与 paper-agent 的条
//   不动，而 dsh 的下载段能动）；
// - 段内比例只在主进程给了 fraction 时才画（下载字节数），其余画不确定态——不编造百分比；
// - 阶段一变即重挂（key=step），所以条的宽度不会从上一阶段的 80% 缓动下来；
// - 起步下限 2%：0% 时也看得见"条在那儿"。
//
// 底座是 shadcn.tsx 的 `Progress`（与 Button/Tooltip 同档的标准 primitive）。

import type { InstallProgressStep, InstallStagePosition } from '@shared/types/installProgress'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { Progress } from './shadcn'

/** 步骤 → 文案键。显式映射取代模板键（v1）：联合穷尽由编译器保证，键为字面量可直接过静态键检。 */
const STEP_LABEL_KEYS: Record<InstallProgressStep, string> = {
  runtime: 'code.install_progress.runtime',
  install: 'code.install_progress.install',
  toolchain: 'code.install_progress.toolchain',
  market: 'code.install_progress.market',
  ppt: 'code.install_progress.ppt',
  source: 'code.install_progress.source',
  extract: 'code.install_progress.extract',
  unpack: 'code.install_progress.unpack',
  venv: 'code.install_progress.venv',
  pip: 'code.install_progress.pip',
  deps: 'code.install_progress.deps',
  front: 'code.install_progress.front',
  build: 'code.install_progress.build',
  deploy: 'code.install_progress.deploy',
  launch: 'code.install_progress.launch'
}

/** 确定性比例换算成百分比：下限 2%（可见）、上限 100%（防浮点越界）。 */
export function progressPercentOf(fraction: number | undefined): number | undefined {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined
  return Math.max(2, Math.min(100, Math.round(fraction * 100)))
}

interface InstallProgressProps {
  step: InstallProgressStep
  /** 语言无关的补充事实（下载字节数等），由主进程给，这里原样展示。 */
  detail?: string
  /** 0..1；缺省 = 本阶段不可测（不确定态）。 */
  fraction?: number
  /** 本次安装在阶段序列里的位置（主进程给；缺省时退化为单条进度条）。 */
  stage?: InstallStagePosition
  className?: string
}

export const InstallProgress: FC<InstallProgressProps> = ({ step, detail, fraction, stage, className }) => {
  const { t } = useTranslation()
  const percent = progressPercentOf(fraction)
  return (
    <Progress
      // 阶段切换即重挂：条从新阶段的起点开始，不继承上一阶段的宽度。
      key={step}
      className={className}
      value={percent}
      {...(stage ? { segments: stage } : {})}
      label={t(STEP_LABEL_KEYS[step])}
      {...(detail ? { detail } : {})}
    />
  )
}
