import { loggerService } from '@logger'
import { useProviders } from '@renderer/hooks/useProvider'
import { getStoreProviders } from '@renderer/hooks/useStore'
import { CLI_OWN_LOGIN_PROVIDER_ID, type CodeCli, isApiGatewayProviderId } from '@shared/types/codeCli'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type ApiKeyEntry,
  type CliConfigConnection,
  cliConfigConnectionMatchesProvider,
  extractConnectionFromCliConfigDraft,
  gatewayExpectedModel,
  readCliConfigFiles,
  resolveCliConfigApplyContext
} from '../cliConfig'
import type { Provider } from '../cliConfig/providerView'
import { safeCreateUniqueModelId } from '../cliConfig/values'
import type { ApiGatewayProviderBundle } from './useApiGatewayProvider'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useCurrentCliConfigConnection.ts
//（2026-09-24）。缝点三处，读-比-置数据流（generation/cancelled 竞态守卫）逐字：
// ① keys 缝：V2 经 DataApi `dataApiService.get('/providers/{id}/api-keys')` 读 provider 密钥表
//   ← fork provider 无独立 keys 表（单 apiKey 字段，redux llm 快照为真源），构造同形单条
//   ApiKeyEntry。
// ② 模型源缝：V2 useModels({enabled:true}) ← fork useProviders 自带 models；gateway 分支的
//   apiModelId 解析按 UniqueModelId 键（createUniqueModelId(provider, id)）比对。
// ③ import 对号：Provider/ApiKeyEntry ← providerView/providerMatching 投影面（4b 装配点
//   先经 toCliProvider 投影再入本层）。

const logger = loggerService.withContext('useCurrentCliConfigConnection')

/**
 * 读失败必须是自己的第三态：`null` 的语义是「磁盘配置与当前服务商一致/无外来配置」——
 * 把读取失败折叠进 null，就是把失败渲染成一次假成功。当前该值没有显示面消费
 * （V2 的消费面随 dormant 的 LaunchDialog 被裁），但契约必须先诚实，未来任何读者
 * 都不会把失败误读成"一致"。
 */
export type CurrentCliConfigConnection = CliConfigConnection | null | 'unreadable'

// fork 缝①：V2 为 `const result = await dataApiService.get(`/providers/${providerId}/api-keys`);
// return result?.keys ?? []`。
async function readProviderApiKeys(providerId: string): Promise<ApiKeyEntry[]> {
  const apiKey = getStoreProviders().find((p) => p.id === providerId)?.apiKey
  return apiKey ? [{ id: 'default', key: apiKey, isEnabled: true }] : []
}

export function useCurrentCliConfigConnection({
  enabledProvider,
  selectedCliTool,
  currentProviderConfig,
  apiGatewayProvider
}: {
  enabledProvider?: Provider
  selectedCliTool: CodeCli
  currentProviderConfig?: CliProviderConfig | null
  apiGatewayProvider?: ApiGatewayProviderBundle | null
}): {
  connection: CurrentCliConfigConnection
  setConnection: (connection: CliConfigConnection | null) => void
  reload: () => void
} {
  const [currentCliConfigConnection, setCurrentCliConfigConnection] = useState<CurrentCliConfigConnection>(null)
  const [reloadRevision, setReloadRevision] = useState(0)
  const readGenerationRef = useRef(0)
  // fork 缝②：V2 为 `const { models } = useModels({ enabled: true })`。
  const { providers } = useProviders()
  const models = useMemo(() => providers.flatMap((p) => p.models), [providers])
  const reload = useCallback(() => setReloadRevision((revision) => revision + 1), [])

  const isGateway = !!enabledProvider && isApiGatewayProviderId(enabledProvider.id)
  const gatewayApiKey = apiGatewayProvider?.apiKey ?? null
  // Resolve the gateway model's apiModelId to a primitive so the effect re-runs only when it changes.
  // fork 缝②：fork 模型无 UniqueModelId 字段，按 provider::id 键比对；命中即取 wire id（fork
  // 模型 id 本身就是 wire id，与 V2 apiModelId 语义对位）。
  const gatewayApiModelId = useMemo(() => {
    if (!isGateway) return undefined
    const modelId = currentProviderConfig?.modelId
    if (!modelId) return undefined
    return models.find((m) => safeCreateUniqueModelId(m.provider, m.id) === modelId)?.id
  }, [isGateway, currentProviderConfig?.modelId, models])

  useEffect(() => {
    const readGeneration = ++readGenerationRef.current
    let cancelled = false
    // The virtual own-login entry has no app-side credential to reconcile against a CLI config file.
    if (!enabledProvider || enabledProvider.id === CLI_OWN_LOGIN_PROVIDER_ID) {
      setCurrentCliConfigConnection(null)
      return
    }

    void (async () => {
      const files = await readCliConfigFiles(selectedCliTool)
      const connection = extractConnectionFromCliConfigDraft(selectedCliTool, files)
      if (!connection) {
        if (!cancelled && readGeneration === readGenerationRef.current) setCurrentCliConfigConnection(null)
        return
      }
      // Gateway: match against the synthetic gateway key (no DataApi record) and the gateway-addressed
      // model, so a live gateway config lights up as active rather than showing as a foreign connection.
      let apiKeys: ApiKeyEntry[]
      let expectedModel: string | undefined
      if (isGateway) {
        apiKeys = gatewayApiKey ? [{ id: 'gateway', key: gatewayApiKey, isEnabled: true }] : []
        expectedModel = gatewayExpectedModel(currentProviderConfig?.modelId, gatewayApiModelId)
      } else {
        apiKeys = await readProviderApiKeys(enabledProvider.id)
        const currentCliConfigContext = resolveCliConfigApplyContext(
          selectedCliTool,
          enabledProvider.id,
          currentProviderConfig ?? undefined
        )
        expectedModel = currentCliConfigContext?.writePrimaryModel ? currentCliConfigContext.rawModelId : undefined
      }
      if (cancelled || readGeneration !== readGenerationRef.current) return
      setCurrentCliConfigConnection(
        cliConfigConnectionMatchesProvider(selectedCliTool, connection, enabledProvider, apiKeys, expectedModel)
          ? null
          : connection
      )
    })().catch((error) => {
      logger.error('Failed to read current CLI config connection:', error as Error)
      if (!cancelled && readGeneration === readGenerationRef.current) setCurrentCliConfigConnection('unreadable')
    })

    return () => {
      cancelled = true
    }
  }, [
    enabledProvider,
    selectedCliTool,
    currentProviderConfig,
    isGateway,
    gatewayApiKey,
    gatewayApiModelId,
    reloadRevision
  ])

  return { connection: currentCliConfigConnection, setConnection: setCurrentCliConfigConnection, reload }
}
