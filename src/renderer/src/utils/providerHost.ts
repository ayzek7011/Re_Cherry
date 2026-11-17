import { type Provider, SystemProviderIds } from '@renderer/types'
import { formatApiHost, formatOllamaApiHost, formatVertexApiHost, isWithTrailingSharp } from '@renderer/utils/api'
import {
  isAnthropicProvider,
  isAzureOpenAIProvider,
  isGeminiProvider,
  isOllamaProvider,
  isPerplexityProvider,
  isVertexProvider
} from '@renderer/utils/provider'
import { cloneDeep } from 'lodash-es'

/**
 * 按 provider 类型规范化 apiHost（从 aiCore 迁移而来，原 providerConfig.formatProviderApiHost）。
 * 渲染进程与内核的 provider 同步、设置页校验共用此规则。
 */

type HostFormatter = {
  match: (provider: Provider) => boolean
  format: (provider: Provider, appendApiVersion: boolean) => string
}

export function formatProviderApiHost(provider: Provider): Provider {
  const formatted = { ...provider }
  const appendApiVersion = !isWithTrailingSharp(provider.apiHost)

  if (formatted.anthropicApiHost) {
    formatted.anthropicApiHost = formatApiHost(formatted.anthropicApiHost, appendApiVersion)
  }

  // Anthropic is special: uses anthropicApiHost as source and syncs both fields
  if (isAnthropicProvider(provider)) {
    const baseHost = formatted.anthropicApiHost || formatted.apiHost
    formatted.apiHost = formatApiHost(baseHost, appendApiVersion)
    if (!formatted.anthropicApiHost) {
      formatted.anthropicApiHost = formatted.apiHost
    }
    return formatted
  }

  const formatters: HostFormatter[] = [
    {
      match: (p) => p.id === SystemProviderIds.copilot || p.id === SystemProviderIds.github,
      format: (p) => formatApiHost(p.apiHost, false)
    },
    { match: isPerplexityProvider, format: (p) => formatApiHost(p.apiHost, false) },
    { match: isOllamaProvider, format: (p) => formatOllamaApiHost(p.apiHost) },
    { match: isGeminiProvider, format: (p, av) => formatApiHost(p.apiHost, av, 'v1beta') },
    { match: isAzureOpenAIProvider, format: (p) => formatApiHost(p.apiHost, false) },
    { match: isVertexProvider, format: (p) => formatVertexApiHost(p as Parameters<typeof formatVertexApiHost>[0]) }
  ]

  const formatter = formatters.find((f) => f.match(provider))
  formatted.apiHost = formatter
    ? formatter.format(formatted, appendApiVersion)
    : formatApiHost(formatted.apiHost, appendApiVersion)

  return formatted
}

/** 兼容旧调用名（原 aiCore adaptProvider 的 apiHost 部分）。 */
export function adaptProviderApiHost(provider: Provider): Provider {
  return formatProviderApiHost(cloneDeep(provider))
}
