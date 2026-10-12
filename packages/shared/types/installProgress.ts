// fork 缝（原创）：受管工具安装进度的**共享词汇表**。
//
// 为什么要单列一件：进度此前是三处各自描述的字符串——主进程广播、preload 桥、渲染层状态
// 与组件 props 各写一遍形状，步骤名更是散在各安装路径里的裸字符串。后果正是用户指出的那类：
// 新工具/新步骤可以悄悄漏掉展示或漏掉文案（"进度条只给某一家做了"）。
//
// 现在它们是同一份契约：
// ① 主进程 `broadcastInstallProgress(tool, step, …)` 的 step 只能是这里的词汇——
//    写错步骤名是**编译错误**，不是运行时空白；
// ② preload 桥的载荷类型、渲染层状态、标准进度元素（InstallProgress）共用 `InstallProgressPayload`；
// ③ 每个步骤的文案键固定为 `code.install_progress.<step>`，由静态检查的 i18n-dynamic 注册表
//    逐条核对两语（新增步骤漏文案 → 门禁变红）。

/** 安装步骤词汇（唯一的步骤名来源）。 */
export const INSTALL_PROGRESS_STEPS = [
  /** 下载运行时（node / CPython）。 */
  'runtime',
  /** npm 安装（dsh 本体）。 */
  'install',
  /** 装配插件工具链（pnpm）。 */
  'toolchain',
  /** 安装插件市场（dshmarket）。 */
  'market',
  /** 安装演示文稿插件（dsh-ppt）。 */
  'ppt',
  /** 获取源码树（GitHub 归档）。 */
  'source',
  /** 解压运行时归档（下载完成之后、安装之前）。 */
  'extract',
  /** 解压源码归档（源码型工具；与 `extract` 分开，否则条会从"获取源码"倒回"解压运行时"）。 */
  'unpack',
  /** 创建 Python 环境。 */
  'venv',
  /** pip 安装依赖（hermes）。 */
  'pip',
  /** pip 安装源码型依赖（paper-agent）。 */
  'deps',
  /** 安装前端依赖（npm install）。 */
  'front',
  /** 构建前端（vite build）。 */
  'build',
  /** 部署前端产物与用户态播种。 */
  'deploy',
  /**
   * 收尾启动核验：把刚装好的受管可执行物真的跑一次（`--version`）。
   *
   * 它必须是**最后一步**：在它之前的各段只证明"命令都成功退出、文件都在"，唯有过这一关
   * 才证明"装出来的东西能启动"。放在写版本标记之前，失败即整次安装失败（见 BinaryManager
   * 的 verifyLaunch）。此前没有这一步，于是"装完了但起不来"能一路报到安装成功。
   */
  'launch'
] as const

export type InstallProgressStep = (typeof INSTALL_PROGRESS_STEPS)[number]

/**
 * 一次安装在进度条上的位置（第几步 / 共几步）。
 *
 * **进度条按阶段分段**。只有下载阶段能算出字节比例；pip/npm/vite 这类"执行"阶段
 * 没有任何诚实的百分比——干等一条脉冲几十秒到十几分钟，用户读到的就是"进度条不动"
 *（真机反馈：hermes 的 pip、paper-agent 的 deps/front）。阶段完成是**事实**，所以拿它当
 * 确定性进度的骨架：已完成 n 段 → 条走到 n/total，当前段内可测时再按字节填。
 * 每段等权是**展示约定**，不是编造的耗时测量。
 */
export interface InstallStagePosition {
  /** 1 起。 */
  index: number
  total: number
}

/**
 * 某步骤在本次安装阶段序列里的位置；不在序列里返回 undefined（调用方据此记日志并降级为
 * "只报步骤名"，绝不猜一个位置）。
 */
export function stagePosition(
  pipeline: readonly InstallProgressStep[],
  step: InstallProgressStep
): InstallStagePosition | undefined {
  const index = pipeline.indexOf(step)
  return index === -1 ? undefined : { index: index + 1, total: pipeline.length }
}

/** 阶段跟踪器的一次进入结果。 */
export interface StageEntry {
  /** 本次广播该带的位置；步骤不在序列里时 undefined（进度条落回不确定态）。 */
  stage?: InstallStagePosition
  /** 该步的位置落后于已到达的最远段——条停在最远处不倒着走（见 createStageTracker）。 */
  held: boolean
}

/**
 * 阶段跟踪器：把"进入某一步"翻译成广播用的位置，并保证**位置单调不回退**。
 *
 * 为什么需要"不回退"：安装序列里可能有两次同类下载（paper-agent 的 CPython 与 node 各自
 * "下载 + 解压"一轮），第二次的步骤名指向前面已经走过的段——如实照发的话，进度条会在下载中途
 * 倒着跳一格。事实是"走过的段不会没走过"（与下载比例 selectProgressUpdate 的单调约定同源），
 * 所以这里停在已到达的最远段；步骤名照发（"正在下载运行时…"是真的），只是位置不动。
 *
 * 是纯函数式的状态机（无 I/O），所以"1 起 / 钳在 max / 跨序列"这些分支可单测。
 */
export function createStageTracker(
  pipeline: readonly InstallProgressStep[]
): (step: InstallProgressStep) => StageEntry {
  let furthest = 0
  return (step) => {
    const position = stagePosition(pipeline, step)
    if (!position) return { held: false }
    const held = position.index < furthest
    const stage = { index: Math.max(position.index, furthest), total: position.total }
    furthest = stage.index
    return { stage, held }
  }
}

/** 进度广播的载荷（主进程 → preload → 渲染层，同一形状）。 */
export interface InstallProgressPayload {
  /** 工具的可执行名（= tools/<name> 目录名）。 */
  tool: string
  step: InstallProgressStep
  /**
   * 语言无关的补充事实（目前是下载字节进度，如 `43% · 12.3/30.5 MB`）。
   * 渲染层原样展示——不做二次拼装，避免两侧各有一套格式。
   */
  detail?: string
  /**
   * 可测阶段的确定性比例（0..1）。缺省表示"该阶段不可测"——渲染层据此画不确定态。
   * 只有真能算出比例的阶段才该给值：宁可显示"不确定"，不显示假进度。
   */
  fraction?: number
  /**
   * 本次安装在阶段序列里的位置。给了它，渲染层就能把**整条进度条**画成
   * "已完成 n 段 + 当前段"：下载段内按 fraction 填，执行段内画不确定态，段一完成即前进。
   */
  stage?: InstallStagePosition
}

/**
 * 组装一条进度载荷：只带**真有值**的字段。
 *
 * 为什么要成一个函数：这一段此前写在各发送点的对象字面量里，而 `{ ...spread }` 恰好绕过
 * 对象字面量的多余属性检查—— 的 `stage` 就这样在主进程里"发了却被广播丢掉"，
 * 类型检查一路绿灯（渲染层永远收不到 stage，进度条不会分段）。现在唯一的组装点在这里，
 * 字段是否落载荷由本函数决定，且它是纯函数（可单测）。
 *
 * 两处判定不是装饰：`fraction` 只接受有限数（NaN/Infinity 会让渲染层算出 NaN% 宽），
 * `detail` 只接受非空串（空串会渲染出一个空的等宽片段）。
 */
export function buildInstallProgressPayload(
  tool: string,
  step: InstallProgressStep,
  options: { detail?: string; fraction?: number; stage?: InstallStagePosition } = {}
): InstallProgressPayload {
  const { detail, fraction, stage } = options
  return {
    tool,
    step,
    ...(detail ? { detail } : {}),
    ...(typeof fraction === 'number' && Number.isFinite(fraction) ? { fraction } : {}),
    ...(stage ? { stage } : {})
  }
}
