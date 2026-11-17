// fork 缝（原创）：code_cli 配置读写通道的**入参断言**（V2 zod schema 的手写等价）。
//
// 为什么单列一件：这两个断言原先写在 ipc.ts 文件尾，唯一定义、唯一使用，**无法单测**——于是
// 一个真实的载荷形状错配（渲染层按 V2 发 `{ targets: [...] }`，主进程却按裸数组断言）在类型
// 检查、静态检查、全部单测下都是绿的，只在真机运行时炸成
//   `Invalid code_cli.read_config input: targets must be an array`
// 而渲染层把这个错误 catch 住只写日志（连接态静默变 null）。断言进本件后有两个好处：
// ① 读/写两条通道的载荷形状都成了**可测契约**；② 形状错配会在单测里按名变红，而不是在用户
// 的日志里出现一行看不懂的英文。
//
// 载荷形状（与渲染层 cliConfig/file.ts 的调用点一致，同为 V2 形状）：
//   读：`{ targets: CliConfigTarget[] }`（去重，首现保留——同 V2 的 z.transform）
//   写：`{ cliTool: FileConfiguredCli, files: CliConfigWriteFile[] }`

import {
  type DeepSeekHarnessAgentPreset,
  type DeepSeekHarnessPermissionMode,
  normalizeDeepSeekHarnessSettings
} from '@shared/types/codeCli'
import { type UniqueModelId, UniqueModelIdSchema } from '@shared/types/uniqueModelId'
import type { CliConfigTarget, CliConfigWriteFile, FileConfiguredCli } from '@shared/utils/cliConfig'
import { CLI_CONFIG_TARGET_IDS, FILE_CONFIGURED_CLI_TOOLS } from '@shared/utils/cliConfig'

/**
 * fork 缝：`'direct' | 'gateway'` 的正源在 services/deepSeekHarness/config.ts（DeepSeekHarnessMode）；
 * 此处内联同形联合，避免为两个字符串字面量把 yaml/内核依赖拉进本件（结构与正源同源，服务端
 * start() 的参数类型按结构收纳）。
 */
export type DeepSeekHarnessStartMode = 'direct' | 'gateway'

/** 单个配置文件的内容上限（V2 同值）：这是配置文件，不是数据搬运通道。 */
export const CLI_CONFIG_CONTENT_LIMIT = 1024 * 1024

/** 只接受白名单内的 target 字符串。 */
function isCliConfigTarget(value: unknown): value is CliConfigTarget {
  return typeof value === 'string' && (CLI_CONFIG_TARGET_IDS as readonly string[]).includes(value)
}

/** 只接受"文件配置型"工具（CodeCli 的取值空间比写通道允许的大）。 */
function isFileConfiguredCli(value: unknown): value is FileConfiguredCli {
  return typeof value === 'string' && FILE_CONFIGURED_CLI_TOOLS.has(value)
}

/**
 * 读通道入参：`{ targets: [...] }` → 去重后的 target 列表。
 *
 * 只认这一种形状：裸数组是**另一个**契约（V2 的 `code_cli.read_config` 载荷从来是对象），
 * 同时接受两种形状等于让"发错了"永远不被发现。
 */
export function parseCliConfigReadInput(payload: unknown): CliConfigTarget[] {
  // 数组也走这一支：它是**另一种**形状，报"期望 { targets: [...] }"比报"targets 必须是数组"更能
  // 指认错误（真机那次就是发对象、收端按数组断言，两边都以为自己在说同一件事）。
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Invalid code_cli.read_config input: expected { targets: [...] }')
  }
  const { targets } = payload as { targets?: unknown }
  if (!Array.isArray(targets)) {
    throw new Error('Invalid code_cli.read_config input: targets must be an array')
  }
  const deduped = new Set<CliConfigTarget>()
  for (const target of targets) {
    if (!isCliConfigTarget(target)) {
      throw new Error(`Invalid config target: ${String(target)}`)
    }
    deduped.add(target)
  }
  return [...deduped]
}

/** 写通道入参：`{ cliTool, files }` → 校验后的写入清单。 */
export function parseCliConfigWriteInput(payload: unknown): {
  cliTool: FileConfiguredCli
  files: CliConfigWriteFile[]
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid code_cli.write_config input')
  }
  const { cliTool, files } = payload as { cliTool?: unknown; files?: unknown }
  if (!isFileConfiguredCli(cliTool)) {
    throw new Error(`Invalid cliTool: ${String(cliTool)}`)
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Invalid code_cli.write_config input: files must be a non-empty array')
  }
  const parsed: CliConfigWriteFile[] = files.map((file) => {
    if (typeof file !== 'object' || file === null) {
      throw new Error('Invalid config file entry')
    }
    const { target, content } = file as { target?: unknown; content?: unknown }
    if (!isCliConfigTarget(target)) {
      throw new Error(`Invalid config target: ${String(target)}`)
    }
    if (typeof content !== 'string' || content.length > CLI_CONFIG_CONTENT_LIMIT) {
      throw new Error(`Invalid config content for ${target}`)
    }
    return { target, content }
  })
  return { cliTool, files: parsed }
}

/** `deepseek_harness.start` 校验后的载荷（主进程面：mode 路由、uniqueModelId 寻址、设置写盘）。 */
export interface DeepSeekHarnessStartPayload {
  mode: DeepSeekHarnessStartMode
  uniqueModelId: UniqueModelId
  agentPreset: DeepSeekHarnessAgentPreset
  permissionMode: DeepSeekHarnessPermissionMode
}

/**
 * 启动通道入参：`{ mode, uniqueModelId, agentPreset?, permissionMode? }`。
 *
 * 这是 code-cli 生命周期组里唯一把渲染层值写进**子进程 env**（`DSH_PERMISSION_MODE`）与
 * **settings.yaml**（`agent-presets.default`）的通道——不经此断言，未知 mode 会被当成
 * direct、任意串会原样落进 env/YAML。settings 两个键走 shared 归一化（未知值回默认，
 * 不抛）；mode 与 uniqueModelId 形状不对即抛（无安全默认可用）。
 */
export function parseDeepSeekHarnessStartInput(payload: unknown): DeepSeekHarnessStartPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid deepseek_harness.start input: expected an object')
  }
  const { mode, uniqueModelId, agentPreset, permissionMode } = payload as Record<string, unknown>
  if (mode !== 'direct' && mode !== 'gateway') {
    throw new Error(`Invalid deepseek_harness.start input: mode must be "direct" or "gateway", got ${String(mode)}`)
  }
  const parsedModelId = UniqueModelIdSchema.safeParse(uniqueModelId)
  if (!parsedModelId.success) {
    throw new Error('Invalid deepseek_harness.start input: uniqueModelId must be "providerId::modelId"')
  }
  return {
    mode,
    uniqueModelId: parsedModelId.data,
    ...normalizeDeepSeekHarnessSettings({ agentPreset, permissionMode })
  }
}
