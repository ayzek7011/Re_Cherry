// fork 移植自 cherry-studio v2 src/renderer/pages/code/types.ts（2026-09-24）。
// fork 缝：VersionStatus 的 applicationStatus 面按 fork BinaryManager 快照子集收窄——
// V2 为 BinaryApplication 对象（src/shared/types/binary.ts，fork 不建该 shared 文件，
// fork 快照 application 为扁平状态串）。
// v1（W4-4）回挂：operation（主进程进行中的安装/卸载）随快照下发（见 :37）；
// 回挂：CodeToolMeta 按 V2 原文补齐（icon 面 = components/CliIcon 的 IconComponent 替身）。

import type { CodeCli } from '@shared/types/codeCli'
import type { InstallProgressPayload } from '@shared/types/installProgress'

import type { IconComponent } from './components/CliIcon'

export interface CodeToolMeta {
  id: CodeCli
  label: string
  icon: IconComponent | null | undefined
}

/** Install/upgrade status for a single CLI tool binary. */
export interface VersionStatus {
  installed: boolean
  source: 'managed' | 'system' | 'none'
  /** Exact-backend-application status; drives update/uninstall/repair authority. */
  applicationStatus?: 'applied' | 'broken' | 'absent'
  systemPath?: string
  current?: string
  latest?: string
  canUpgrade: boolean
  /**
   * （）：注册表型工具的"最新版"查询失败时为 true。版本卡据此**不渲染**"已是最新"
   * 徽章——查询失败与"没有更新"是两回事，后者冒充前者就是假陈述。
   */
  latestUnknown?: boolean
  /**
   * （）：主进程记录的上次安装/升级失败原因。版本卡的失败行据此持久显示
   * （刷新/重启后仍在）——此前失败原因只活在一次 toast 里。
   */
  lastFailure?: string
  /**
   * v1（W4-4）：主进程正在进行的操作（随快照下发）。页面重挂载后据此恢复"正在安装/卸载"，
   * 不再依赖组件局部 busy 集合（切页即销毁，进度看起来就"丢了"）。
   */
  operation?: {
    kind: 'install' | 'remove'
    at: number
    progress?: InstallProgressPayload
  }
}
