# 限制与基线

本文件记录两类事实：有意保留的设计限制，以及性能基线与测量口径。

## 有意保留

改这些之前先给出理由与测试。

| 项 | 事实 |
|---|---|
| 知识库检索 | O(n) 余弦扫描。个人规模够快 |
| 剪贴板 | `PasteService` 同时有文本与图片时优先文本。要改需先做新的粘贴解析器 |
| `Provider.isNotSupport*` | 看着像废弃字段，实际是迁移输入与在线 UI 输入。不要删 |
| 全局记忆 | 已移除。唯一记忆面是文件记忆：`memory` 工具在工作模式运行，每轮注入 `FACT.md` |
| `lodash` | 渲染层已整体迁移到 `lodash-es`（tree-shake，见 1.2.0 首屏基线）；主进程保持 CommonJS `lodash`（`electron.vite.config.ts` 按 dependencies 外置）。`messageTranslate.ts` 的 `DebouncedFuncLeading` 类型从 `@types/lodash` 的 `lodash` 取（`@types/lodash-es` 不转发该类型；type-only import 编译期擦除，无运行时双实例） |
| Shiki | 带全部语言语法，每份语法是懒 chunk。出网子集能省磁盘，但生僻语言会退化成纯文本 |
| `ComposerToolRuntime` | 保留三个惰性的 V2 对等占位。绘画 composer 消费它们 |
| `ImageViewer` | 接受 `_` 前缀的未用 props，为了 antd 兼容 |
| Windows 沙箱子进程 | 用 `CREATE_NEW_CONSOLE` + `STARTF_USESHOWWINDOW(SW_HIDE)`。受限令牌方案禁止 `CREATE_NO_WINDOW`，用了子进程会以 `0xC0000142` 死掉。不要换成 `windowsHide` |
| 截图工具 | 未实现 |
| 备份对运行中数据库的一致性 | `BackupManager.backup` 在应用运行中直拷 Chromium 的 `IndexedDB`/`Local Storage`（LevelDB）目录，不是停机快照。LevelDB 按崩溃恢复语义丢弃撕裂的 log 尾部：老数据不受损，最坏丢最近未 checkpoint 的写入。上游同行为。真一致快照需要 renderer 静默机制，与收益不成比例，不做。瞬时文件锁（EBUSY/EPERM）已用 `copyDirWithTransientRetry` 短重试兜住 |

## 已知行为边界

| 项 | 事实 |
|---|---|
| 暂停的"安装/升级"口径 | 主进程分不清两者（IPC 面同为 `install_tool`，只有渲染层知道）。切页回来时"升级中"显示为"安装中" |
| PDF 文本层读取的中断粒度 | 单次 pdfjs 调用内部不可中断，检查点在读取之前。实测 178 MB / 530 页读取 116 ms，等待窗口可忽略 |
| 文档处理通道 | OCR 只接 PDF。非 PDF 明文报错 |

## 未闭环项

**正文流式停顿（E1）**。停顿本身仍未复现。两个渲染侧成因已修复并实测：
`Markdown` 把文本切成"稳定前缀 + 增长尾部"，管线每帧只跑几次；smooth-stream 回调钳到 30 Hz；
store 收到的是增量而不是全文。**不要重新整篇解析每条消息**。
取证钩子（`noteStreamActivity`，在 `kernelChat.ts`）保留：它测量任意事件的间隔，
思考期与工具期不算停顿；间隔超过 5 秒记一条含 `no stream activity` 的 warn。
捕获到真实停顿并修复之后再删这个钩子。

## 首屏面基线

首屏面有两个口径，回答两个不同问题：

- **FACE A（预载面）**：`index.html` 直接点名的资源总和（入口脚本 + `modulepreload` +
  样式表）。这是浏览器为首屏**取回**的字节。
- **FACE B（执行闭包）**：入口脚本的静态 import 闭包。这是首屏前必须**解析并执行**的字节。
  静态值导入改成动态导入时，动的是这个数。

0.5.2 的基线：

| 项 | 字节 |
|---|---|
| FACE A | 12,373,794 |
| FACE B | 12,185,742 |
| store chunk | 2,051,058 |
| 快捷助手窗口首屏 | 9,361,193 |
| `out/renderer` 资源文件数 | 896 |

1.2.0 的基线（懒化弹窗链与 locale、lodash-es 迁移后的实测，同口径）：

| 项 | 字节 | 对 0.5.2 |
|---|---|---|
| FACE A | 9,538,109 | −22.9% |
| FACE B | 9,350,057 | −23.3% |
| store chunk | 1,977,240 | −3.6% |
| 快捷助手窗口首屏 | 8,013,650 | −14.4% |
| trace 窗口首屏 | 6,440,219 | — |
| `out/renderer` 资源文件数 | 946 | +50（懒化拆分的必然结果，不在首屏面） |

1.2.0 懒化的清单（回退这些改动前先测首屏面）：`OnboardingPage` 整链（Router.tsx）、
`ErrorDetailModal`（ErrorBlock/ProviderSetting/ModelListItem 三入口处理器内动态 import）、
CodeMirror 链（`HtmlArtifactsCard` 弹窗、`view.tsx` 的 `CodeEditor`、`CodeStyleProvider` 的
`@uiw/codemirror-themes-all`，全部动态）、`SelectModelPopup`（MessageMenubar/Chat/SelectModelButton）、
`AssistantSettingsPopup`/`AgentSettingsPopup`（Navbar/Tabs/AssistantItem/Prompt/TopicContent 五入口）、
`ObsidianExportPopup`（MessageMenubar/Topics）、`InspectMessagePopup` 与附件预览（MessageMenubar/useAttachment）、
franc-min（translate.detectLanguage）、browser-image-compression（utils/image.compressImage）、
zh-cn 语言包（`initI18n` 动态装载，en-US 是静态兜底语言）。
剩余的大块（antd `es-*`、react-dom `en_US`、store、jsx-runtime、MessageErrorBoundary 的 Markdown 全套）
是有意保留或有结构成本，见调查报告 `docs/v1.2-investigation-issue5-chunks.md`。

KaTeX 与 MathJax 是懒加载。Vite 仍为 KaTeX chunk 写 `modulepreload` 提示，
所以那次改动省的是解析与执行，不是文件读取。

测量命令：`pnpm build && node tools/measure-eager.cjs [--json]`。

## 不要给渲染层加 manualChunks

实测结论：按包把 vendor 库分组会把首屏面从 12.50 MB 抬到 14.95 MB（+22.7%）。
强制分组破坏了首屏与懒路由共用的默认 chunk，于是一个即时消费方会把整个库拖进来。
改动 chunk 策略前后都要测首屏总量。
