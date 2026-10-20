import { loggerService } from '@logger'
import { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import { setCodeCliConfigs } from '@renderer/store/settings'
import { CLI_OWN_LOGIN_PROVIDER_ID, CodeCli, isApiGatewayProviderId } from '@shared/types/codeCli'
import type { CliProviderConfig, CodeCliConfigs, CodeCliId, CodeCliToolState } from '@shared/types/codeCliState'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// fork 移植自 cherry-studio v2 src/renderer/hooks/useCodeCli.ts（2026-09-24）。
// 缝点两处，已标 `// fork 缝`：
// ① 持久化缝：V2 `usePreference('feature.code_cli.configs')` → fork redux settings 切片
//   （useAppSelector + dispatch(setCodeCliConfigs(next))；键名常量随 preference 面移除）。
//   写队列串行化语义逐字保留（configsRef + writeQueueRef 机制——setConfigs 为整值替换，
//   无 updater 形式，串行队列防止并发写互相覆盖）。
// ② DEFAULT_TOOL 缝：V2 为 CodeCli.CLAUDE_CODE；fork 保留工具首项为 DEEPSEEK_HARNESS。
// 其余逐字。

const logger = loggerService.withContext('useCodeCli')

// fork 缝①：V2 为 `const PREFERENCE_KEY = 'feature.code_cli.configs'`。
const DEFAULT_TOOL = CodeCli.DEEPSEEK_HARNESS

const EMPTY_TOOL_STATE: CodeCliToolState = { providers: {}, current: null }

function getToolState(toolId: CodeCliId, configs: CodeCliConfigs | undefined): CodeCliToolState {
  // fork 缝③：configs 可能为 undefined（redux-persist 整片替换 initialState——见
  // migrate '223' 的回填；此处再守一道，任何旁路（如跨窗口同步）都不至于崩）。
  const state = configs?.[toolId] ?? EMPTY_TOOL_STATE
  // Dev profiles written before `modelId: UniqueModelId | null` may hold the
  // legacy '' sentinel; normalize on read (this is the preference's only read
  // choke point) so the next write self-heals. No migration needed.
  const legacyIds = Object.keys(state.providers).filter((id) => (state.providers[id].modelId as string) === '')
  if (legacyIds.length === 0) return state
  const providers = { ...state.providers }
  for (const id of legacyIds) {
    providers[id] = { ...providers[id], modelId: null }
  }
  return { ...state, providers }
}

export const useCodeCli = (initialTool: CodeCli = DEFAULT_TOOL, onToolChange?: (tool: CodeCli) => void) => {
  // fork 缝①：V2 为 `const [configs, setConfigs] = usePreference(PREFERENCE_KEY)`。
  const dispatch = useAppDispatch()
  // fork 缝③：`?? {}` 兜底（migrate '223' 已回填，此处防任何旁路写入 undefined）。
  const configs = useAppSelector((s: RootState) => s.settings.codeCliConfigs ?? ({} as CodeCliConfigs))
  const setConfigs = useCallback((next: CodeCliConfigs) => dispatch(setCodeCliConfigs(next)), [dispatch])

  // Mirror configs in a ref so sequential writes read the freshest value.
  // A write queue serialises patchToolState calls so two concurrent writes
  // never clobber each other (setConfigs takes a plain value, not an updater).
  const configsRef = useRef(configs)
  configsRef.current = configs
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())

  const [selectedCliTool, setSelectedCliTool] = useState<CodeCli>(initialTool)

  useEffect(() => setSelectedCliTool(initialTool), [initialTool])

  const selectTool = useCallback(
    (tool: CodeCli) => {
      setSelectedCliTool(tool)
      onToolChange?.(tool)
    },
    [onToolChange]
  )

  const currentToolState = useMemo(() => getToolState(selectedCliTool, configs), [selectedCliTool, configs])

  const currentProviderId = currentToolState.current
  const currentProviderConfig = useMemo(
    () => (currentProviderId ? (currentToolState.providers[currentProviderId] ?? null) : null),
    [currentToolState, currentProviderId]
  )
  const selectedTerminal = currentToolState.terminal
  const directory = currentToolState.directory
  const providerConfigs = currentToolState.providers

  const patchToolState = useCallback(
    (toolId: CodeCliId, patch: (prev: CodeCliToolState) => CodeCliToolState): Promise<void> => {
      const task = writeQueueRef.current.then(async () => {
        const latest = configsRef.current
        const prev = getToolState(toolId, latest)
        const next = { ...latest, [toolId]: patch(prev) }
        configsRef.current = next
        // dispatch 同步完成（setConfigs 返回 action 非 Promise，await 是空转）
        setConfigs(next)
      })
      writeQueueRef.current = task.catch(() => {})
      return task
    },
    [setConfigs]
  )

  const upsertProviderConfig = useCallback(
    async (
      providerId: string,
      partial: Pick<CliProviderConfig, 'modelId'> & Partial<CliProviderConfig>
    ): Promise<string> => {
      const toolId = selectedCliTool
      await patchToolState(toolId, (prev) => {
        // existing 必须在 patch 回调（队列串行点）内读取：队列外读 configsRef 会拿到
        // "已入队未执行"的旧值，其 config/sortIndex 随后被本次写入覆盖（丢更新）。
        const existing = prev.providers[providerId]
        const nextConfig = 'config' in partial ? partial.config : existing?.config
        const next: CliProviderConfig = {
          modelId: partial.modelId,
          ...(nextConfig !== undefined ? { config: nextConfig } : {}),
          ...(partial.sortIndex !== undefined || existing?.sortIndex !== undefined
            ? { sortIndex: partial.sortIndex ?? existing?.sortIndex }
            : {})
        }
        return {
          ...prev,
          providers: { ...prev.providers, [providerId]: next }
        }
      })
      logger.info('Upserted CLI provider config', { toolId, providerId })
      return providerId
    },
    [patchToolState, selectedCliTool]
  )

  const deleteProviderConfig = useCallback(
    async (providerId: string) => {
      const toolId = selectedCliTool
      await patchToolState(toolId, (prev) => {
        const nextProviders = { ...prev.providers }
        delete nextProviders[providerId]
        return {
          ...prev,
          providers: nextProviders,
          current: prev.current === providerId ? null : prev.current
        }
      })
    },
    [patchToolState, selectedCliTool]
  )

  const setCurrentProvider = useCallback(
    async (providerId: string | null) => {
      const toolId = selectedCliTool
      await patchToolState(toolId, (prev) => ({ ...prev, current: providerId }))
    },
    [patchToolState, selectedCliTool]
  )

  const reorderProviders = useCallback(
    async (orderedIds: string[]) => {
      const toolId = selectedCliTool
      await patchToolState(toolId, (prev) => {
        const nextProviders = { ...prev.providers }
        for (let i = 0; i < orderedIds.length; i++) {
          const id = orderedIds[i]
          const existing = nextProviders[id]
          if (!existing) {
            // The virtual own-login / Cherry-gateway entries have no real config; persist a
            // placeholder so their drag position sticks. Real unconfigured providers are still
            // skipped (no empty configs).
            if (id === CLI_OWN_LOGIN_PROVIDER_ID || isApiGatewayProviderId(id)) {
              nextProviders[id] = { modelId: null, sortIndex: i }
            }
            continue
          }
          nextProviders[id] = { ...existing, sortIndex: i }
        }
        return { ...prev, providers: nextProviders }
      })
    },
    [patchToolState, selectedCliTool]
  )

  const setTerminal = useCallback(
    async (terminal: string) => {
      await patchToolState(selectedCliTool, (prev) => ({ ...prev, terminal }))
    },
    [patchToolState, selectedCliTool]
  )

  const setDirectory = useCallback(
    async (directory: string) => {
      await patchToolState(selectedCliTool, (prev) => ({ ...prev, directory }))
    },
    [patchToolState, selectedCliTool]
  )

  const selectFolder = useCallback(async (): Promise<string | null> => {
    try {
      const folderPath = await window.api.file.selectFolder()
      if (folderPath) {
        await setDirectory(folderPath)
        return folderPath
      }
      return null
    } catch (error) {
      logger.error('Failed to select folder:', error as Error)
      throw error
    }
  }, [setDirectory])

  return {
    configs,
    selectedCliTool,
    currentToolState,
    currentProviderId,
    currentProviderConfig,
    providerConfigs,
    directory,
    selectedTerminal,
    upsertProviderConfig,
    deleteProviderConfig,
    setCurrentProvider,
    reorderProviders,
    selectTool,
    setTerminal,
    setDirectory,
    selectFolder
  }
}
