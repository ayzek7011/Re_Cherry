import { isRerankModel } from '@renderer/config/models'
import { checkModelsHealth } from '@renderer/services/HealthCheckService'
import type { Model, Provider } from '@renderer/types'
import type { ModelWithStatus } from '@renderer/types/healthCheck'
import { HealthStatus } from '@renderer/types/healthCheck'
import { splitApiKeyString } from '@renderer/utils/api'
import { summarizeHealthResults } from '@renderer/utils/healthCheck'
import { isEmpty } from 'lodash-es'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import HealthCheckPopup from './HealthCheckPopup'

export const useHealthCheck = (provider: Provider, models: Model[]) => {
  const { t } = useTranslation()
  const [modelStatuses, setModelStatuses] = useState<ModelWithStatus[]>([])
  const [isChecking, setIsChecking] = useState(false)

  /** 卸载守卫：健康检查是长跑网络请求，卸载后不再写状态。 */
  const isMountedRef = useRef(true)
  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const runHealthCheck = useCallback(async () => {
    const modelsToCheck = models.filter((model) => !isRerankModel(model))

    if (isEmpty(modelsToCheck)) {
      window.toast.error({
        timeout: 5000,
        title: t('settings.provider.no_models_for_check')
      })
      return
    }

    const keys = splitApiKeyString(provider.apiKey)

    // 若无 key，插入空字符串以支持本地模型健康检查
    if (keys.length === 0) {
      keys.push('')
    }

    // 弹出健康检查参数配置弹窗
    const result = await HealthCheckPopup.show({
      title: t('settings.models.check.title'),
      provider,
      apiKeys: keys
    })

    if (result.cancelled) {
      return
    }

    // 初始化健康检查状态
    const initialStatuses: ModelWithStatus[] = modelsToCheck.map((model) => ({
      model,
      checking: true,
      status: HealthStatus.NOT_CHECKED,
      keyResults: []
    }))
    setModelStatuses(initialStatuses)
    setIsChecking(true)

    // 执行健康检查，逐步更新每个模型的状态
    const checkResults = await checkModelsHealth(
      {
        provider,
        models: modelsToCheck,
        apiKeys: result.apiKeys,
        isConcurrent: result.isConcurrent,
        timeout: result.timeout
      },
      (checkResult, index) => {
        setModelStatuses((current) => {
          const updated = [...current]
          if (updated[index]) {
            updated[index] = {
              ...updated[index],
              ...checkResult,
              checking: false
            }
          }
          return updated
        })
      }
    )

    if (!isMountedRef.current) {
      return
    }

    // 「整批都没跑起来」必须走错误信号。修改前这里无条件用 info toast 播汇总，
    // 整体失败会渲染成「0/N 通过」的成功态。
    const hasAnySuccess = checkResults.some((r) => r.keyResults.some((kr) => kr.status === HealthStatus.SUCCESS))
    const toastTitle = summarizeHealthResults(checkResults, provider.name)
    if (hasAnySuccess) {
      window.toast.info({ timeout: 5000, title: toastTitle })
    } else {
      window.toast.error({ timeout: 5000, title: toastTitle })
    }

    setIsChecking(false)
  }, [models, provider, t])

  return {
    isChecking,
    modelStatuses,
    runHealthCheck
  }
}
