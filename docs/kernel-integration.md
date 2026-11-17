# 内核集成

DSH 内核（DeepSeek Harness，Cordis 插件宿主）在 main 进程内运行。本仓只通过公开缝与它对接。

## 禁区

- 不修改 `node_modules/@deepseek-ai/*` 的任何文件。
- 不修改 `patches/` 下的文件。
- 不绕过 Cordis 插件生命周期。
- 不在内核之外打开内核 SQLite。不重命名内核会话事件。

内核集成层在本仓：`src/main/kernel/`。这一层可以自由修改。

## 可用的公开缝

| 缝 | 用途 |
|---|---|
| `ctx.agents` | 创建、恢复、销毁 agent 与 session |
| `ctx.sessionPersistence` | 会话日志的读写与存在性查询 |
| `ctx.llm.stream()` / `prepareCall().stream()` | 发起模型调用 |
| `llm/stream` waterfall | 拦截或包装每一次流式模型调用（响应端） |
| `ctx.llm.resolveModelInfo()` | 查询确切模型能力（上下文、输出上限、推理） |
| `ToolRuntime` / `ctx.tools` | 注册工具、挂载工具面 |
| `session/event` | 订阅会话事件（广播、`uiEvents`、搜索共用同一判据） |
| `ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning` | 本仓注册的应用服务缝（`registerAppServiceSeams`） |

## 会话日志是唯一真相源

- 每一条会话状态都必须能由日志折叠出来。
- 不要引入第二个真相源。渲染层的消息与块是投影结果，不落盘。
- wire 侧的改写不得触碰数据库。
- 新增自定义会话事件时给信封加 `ignorable: true`。否则旧行读不出来。

## 话题与建册

- 话题成员资格以 `dshTopicList` 为准。不要复活已删除的话题 id。
- `ensureAgent` 绝不可在已有日志之上新建会话。
  `src/main/kernel/sessionResumeFallback.ts` 做这个判断：它查持久化是否存在，问不到就不建。
- 内核查询一律经 `retryKernelQuery`，以容忍启动窗口。
  三值语义：`undefined` = 稍后重试；其它值（含 `false`、空值）= 终局；`null` = 问不到。
  只有 `false` 可以拒绝。`null` 不得用于拒绝，也不得用于隐藏数据。
- 不可知状态不得授权破坏性动作。注册表 `failed` 不等于 `absent`：
  解析失败就跳过清扫并备份原文件。

## 补丁策略

优先找公开缝。只有没有任何缝能到达问题时才补内核包，并且：

1. 只加一行 `globalThis` 门。
2. 门必须是中性的：门不存在时，包的行为与上游完全一致。
3. 响应端的行为改动走 `llm/stream` waterfall，不要改包。

当前唯一的请求端补丁文件持有两个中性门：思考回放剥离（`thinkingReplay.ts`）与
图片句柄短锚（`imageHandleText.ts`）。响应端的两件（DSML 修复、在途模型流切断）都挂在
`llm/stream` waterfall 上。

## 本仓的内核集成模块

| 模块 | 职责 |
|---|---|
| `kernel/index.ts` | 内核启动、通道注册、应用服务缝、provider 路由同步 |
| `kernel/topics.ts` | 话题注册表、发送参数登记、每个 agent 的工具面 |
| `kernel/sessionEventView.ts` | 事件可见性的唯一判据 |
| `kernel/sessionResumeFallback.ts` | 建册门控（问不到就不建） |
| `kernel/lightLlmModalities.ts` | 非会话模态：embed / rerank / 视觉文档 / 图像 |
| `kernel/dsmlRepair.ts` | 响应端把泄漏的 DSML 标记转回真 tool-call |
| `kernel/modelStreamAbort.ts` | 按话题登记中断控制器，按暂停键切断在途模型流 |
| `kernel/*Tool.ts` | 内置工具：`read_document`、`ocr_document`、`web_search`、`knowledge_search`、`skill`、`memory`、`generate_image`、`describe_images`、`save_attachment`、`ask_user_question`、`documents_extract`（外置，工作模式） |

## 启动顺序是安全属性

在 `src/main/index.ts` 里保持这个顺序：

1. `registerShortcuts()` 与 `await registerIpc()` 先执行。它们是可用性底线。
2. 之后才是外观类初始化（托盘、应用菜单、电源守护、trace、analytics）。
3. 每个可选初始化器包 `try/catch`，失败只记日志。

依据：托盘构造曾抛错并带走整条后续链，表现为快捷键失效、窗口关闭失灵、大量 IPC 无 handler。

## 内核查询与暂停

- 暂停键 → `Dsh_TopicStop` → 主进程先中止本话题下自己登记的长活，再让内核收尾。
- 在途的模型流由 `modelStreamAbort` 切断：它把本仓的中断控制器合成进 `options.signal`，
  运行时把中止规范成 `finish { kind: 'aborted' }`。
- 内核的 `topicTree.stop()` 只在回合边界生效。不要依赖它中断在途工作。
