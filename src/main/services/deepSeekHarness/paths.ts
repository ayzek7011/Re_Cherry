// fork 缝：CodeMate 的路径注册（2026-09-24）。
// V2 用 pathRegistry（application.getPath('external.deepseek_harness.config') 等）；
// fork 全部钉进数据目录的 CodeMate 子树——随"设置 › 数据目录"迁移、portable 版随
// 应用目录走、卸载=删子树（无残留）。

import path from 'node:path'

import { app } from 'electron'

function codeMateRoot(): string {
  return path.join(app.getPath('userData'), 'Data', 'CodeMate')
}

/** DSH_HOME：settings.yaml / .credentials.yaml / 会话数据都在这里。 */
export function deepSeekHarnessHome(): string {
  return path.join(codeMateRoot(), 'home', 'dsh')
}

/** dsh web 进程的工作目录（编码会话的默认 cwd）。 */
export function deepSeekHarnessWorkspace(): string {
  return path.join(codeMateRoot(), 'workspace')
}

/** HERMES_HOME：config.yaml / .env / 会话数据都在这里。 */
export function hermesHome(): string {
  return path.join(codeMateRoot(), 'home', 'hermes')
}

/**
 * 受管工具的通用用户态根 `home/<tool>`（dsh/hermes 的既有两处等价于此命名）。
 * 卸载不删（dsh home 先例）——源码型工具的用户态（config/data/logs/前端产物）钉在此，
 * 与 tools/<tool> 的代码树分离，升级整树替换源码也不碰用户数据。
 */
export function codeMateToolHome(tool: string): string {
  return path.join(codeMateRoot(), 'home', tool)
}

/** 受管 CLI 工具的安装根（安装器使用）。 */
export function codeMateToolsRoot(): string {
  return path.join(codeMateRoot(), 'tools')
}

// ---------------------------------------------------------------------------
// portable 受管 CLI 安装器的运行时 / 缓存布局（fork 缝（原创）：V2 为 mise
// 驱动（运行时与工具都在 mise 管理目录），本组路径为 portable 等价实现——一切钉在
// CodeMate 子树：runtime/node|python/<ver>、tools/<tool>、cache/{npm,pip,downloads}；
// 不改系统 PATH、不写用户全局配置，卸载 = 删子树。设计来源：V2 BinaryManager/
// pythonRuntime + 勘查报告结论。
// ---------------------------------------------------------------------------

/** 受管运行时根（node / python 版本目录的父级）。 */
export function codeMateRuntimeRoot(): string {
  return path.join(codeMateRoot(), 'runtime')
}

/** 受管 node 运行时目录（dsh 的 npm 安装依赖它）。 */
export function nodeRuntimeDir(version: string): string {
  return path.join(codeMateRuntimeRoot(), 'node', version)
}

/** 受管 CPython 运行时目录（hermes 的 venv 依赖它）。 */
export function pythonRuntimeDir(version: string): string {
  return path.join(codeMateRuntimeRoot(), 'python', version)
}

/** 下载 / npm / pip 缓存根（cache/downloads、cache/npm、cache/pip）。 */
export function cacheRoot(): string {
  return path.join(codeMateRoot(), 'cache')
}

/** 换代记录：上次成功就绪的 dsh 版本（启动预检的对照；只由 DeepSeekHarnessService 读写）。 */
export function harnessGenerationRecord(): string {
  return path.join(codeMateRoot(), 'harness-generation.json')
}
