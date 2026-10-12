// fork 缝（原创）：受管工具布局单点。
//
// 为什么要有这件：同一份"装到哪"的知识此前散在三处——`BinaryManager.managedBinaryPath`
// （安装器）、`resolveBinary.managedBinaryPath`（解析器；文件头注释写着"与 BinaryManager 的
// managedBinaryPath 保持一致"）、`PaperAgentService.toolDir/sourceTreeDir/venvPython`
// （Web UI 生命周期）。靠注释维持的"保持一致"已经漂移过一次：`resolveBinary` 至今不认识
// paper-agent——任何走它的通道都会把已安装的源码型工具判成"未安装"。三个消费者改为
// import 本件，布局只在一个地方定义。

import path from 'node:path'

import { isWin } from '@main/constant'
import { codeMateRuntimeRoot, codeMateToolsRoot } from '@main/services/deepSeekHarness/paths'

import { BINARY_TOOL_PRESETS, type BinaryToolPreset } from './presets'

/** 安装后端映射出的布局类别（`registry`/`aqua` 等未支持的后端没有受管布局）。 */
export type ManagedToolKind = 'npm' | 'venv' | 'source'

/**
 * 预设 → 布局类别。未支持的后端返回 undefined（调用方各自决定"跳过"还是"报错"：
 * 安装器选择告警跳过，解析器选择回落到系统 PATH）。
 */
export function managedToolKind(preset: BinaryToolPreset): ManagedToolKind | undefined {
  switch (preset.install) {
    case 'npm':
      return 'npm'
    case 'pipx':
      return 'venv'
    case 'source':
      return 'source'
    default:
      return undefined
  }
}

const KIND_BY_EXECUTABLE: ReadonlyMap<string, ManagedToolKind> = new Map(
  BINARY_TOOL_PRESETS.flatMap((preset) => {
    const kind = managedToolKind(preset)
    return kind ? [[preset.executable, kind] as const] : []
  })
)

/** 按可执行名查布局类别（不在预设表里的返回 undefined）。 */
export function managedToolKindFor(executable: string): ManagedToolKind | undefined {
  return KIND_BY_EXECUTABLE.get(executable)
}

/** 受管工具目录（`tools/<name>`；name = executable）。 */
export function toolDir(name: string): string {
  return path.join(codeMateToolsRoot(), name)
}

/** 源码型工具的源码树落点（升级整树替换；用户态不在此，见 codeMateToolHome）。 */
export function sourceTreeDir(name: string): string {
  return path.join(toolDir(name), 'src')
}

/** 源码型工具的 venv 落点（跨升级保留，依赖变更由 pip 增量解析）。 */
export function sourceVenvDir(name: string): string {
  return path.join(toolDir(name), 'venv')
}

/** venv 型工具（pipx 等价物）的 venv 落在工具目录本身。 */
export function venvPython(name: string): string {
  return isWin ? path.join(toolDir(name), 'Scripts', `${name}.exe`) : path.join(toolDir(name), 'bin', name)
}

/** 源码型 venv 的解释器（受管"可执行物"，也是快照探针与存在性判据）。 */
export function sourceVenvPython(name: string): string {
  return isWin
    ? path.join(sourceVenvDir(name), 'Scripts', 'python.exe')
    : path.join(sourceVenvDir(name), 'bin', 'python3')
}

/** npm 型工具的 bin shim 目录（`tools/<name>/node_modules/.bin`）。 */
function npmToolBinDir(name: string): string {
  return path.join(toolDir(name), 'node_modules', '.bin')
}

/**
 * 受管可执行物的落点（快照探针、启动解析、生命周期服务共用）。
 * 未知工具（不在预设表里）返回 undefined——**不要**在此为未知名字猜一个路径。
 *
 * 注意 venv/source 两型的"可执行物"是 **python.exe 本身**（不是 hermes / paper-agent 的
 * 入口脚本）：快照与解析层的 `--version` 探针因此只证明解释器在，证明不了工具本体能起来。
 * 本体能不能跑由安装收尾的启动核验（BinaryManager 的 launch 阶段）负责。
 */
export function managedBinaryPathFor(executable: string): string | undefined {
  switch (managedToolKindFor(executable)) {
    case 'npm':
      // npm 型：bin shim 在 node_modules/.bin（Windows 为 .cmd）。
      return path.join(npmToolBinDir(executable), isWin ? `${executable}.cmd` : executable)
    case 'venv':
      return venvPython(executable)
    case 'source':
      return sourceVenvPython(executable)
    default:
      return undefined
  }
}

/**
 * 受管 node 运行时根（版本目录的父级 `runtime/node`）。
 *
 * 真机事故（测试者机器：受管 dsh 装好了但一启动就报"损坏或过时的安装"）：npm 的
 * bin shim（`node_modules/.bin/dsh.cmd`）自己**不带 node**，它读 `%dp0%\node.exe`，
 * 读不到就回退到 **PATH 上的 `node`**（`_prog=node.exe`）。而探针子进程的 env 来自
 * `getShellEnv()`，其中并没有受管 node 运行时的目录——于是：
 *   · 机器上另装了 node（开发者机）→ shim 找到系统 node（很可能是**另一个版本**）
 *     → 探针通过，缺陷不可见；
 *   · 干净机器（测试者机）→ 找不到 `node` → shim 直接失败 → 判成"损坏安装"，
 *     而受管 node 明明就躺在 runtime/node/<版本> 里。
 *
 * 同一份事实此前只被 DeepSeekHarnessService 的**启动**路径手工前置过（那里直接 spawn
 * 受管 node.exe，不走 shim，所以能启动），探针路径从未拿到 → "装好了但报坏的"。
 * 探针与启动必须看同一份环境，故由 shellEnv 统一把受管 node 挂进 PATH。
 *
 * **目录里不含版本号**：版本段由 `runtime/node/.codemate-runtime-version`（受管运行时标记）
 * 自证，调用方枚举实际安装的版本目录——这样将来升级 NODE_VERSION 不会让探针 PATH 悄悄失配。
 * 本函数只算路径、不查盘（查盘在 shellEnv）。
 */
export function managedNodeRuntimeRoot(): string {
  return path.join(codeMateRuntimeRoot(), 'node')
}

/**
 * 全部 npm 型工具的 bin shim 目录（dshmarket provision 的 pnpm/npm shim 就落在 dsh 的
 * `.bin` 里，启动路径此前手工前置过它）。
 *
 * 从**预设表**推导，不写工具名：此前是 `path.join(codeMateToolsRoot(), 'dsh',
 * 'node_modules', '.bin')` 的硬编码，加第二个 npm 型工具时它的 shim 会静默漏出 PATH。
 * 顺序即 BINARY_TOOL_PRESETS 的顺序，调用方直接 spread 进 PATH。
 */
export function managedToolBinDirs(): string[] {
  return BINARY_TOOL_PRESETS.filter((preset) => managedToolKind(preset) === 'npm').map((preset) =>
    npmToolBinDir(preset.executable)
  )
}
