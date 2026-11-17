import ModelSelector from '@renderer/components/ModelSelector'
import { TopView } from '@renderer/components/TopView'
import { isRerankModel } from '@renderer/config/models'
import i18n from '@renderer/i18n'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { Model, Provider } from '@renderer/types'
import { Modal } from 'antd'
import { first } from 'lodash-es'
import { useCallback, useMemo, useState } from 'react'

interface ShowParams {
  provider: Provider
}

interface Props extends ShowParams {
  resolve: (data: Model | null) => void
}

const PopupContainer: React.FC<Props> = ({ provider, resolve }) => {
  const [open, setOpen] = useState(true)

  // Keep the natural order of models
  const models = useMemo(() => provider.models.filter((m) => !isRerankModel(m)), [provider])

  const [model, setModel] = useState(first(models))

  const modelPredicate = useCallback((m: Model) => !isRerankModel(m), [])

  const defaultModelValue = useMemo(() => {
    return model ? getModelUniqId(model) : undefined
  }, [model])

  const onOk = () => {
    if (!model) {
      window.toast.error(i18n.t('message.error.enter.model'))
      return
    }
    setOpen(false)
    resolve(model)
  }

  /**
   * 取消 = 交回 `null` 哨兵。
   *
   * 旧实现在这里排了一个 300ms 的 `reject`：`useTimer` 卸载时会 `clearAllTimers()`，
   * 弹窗关闭即卸载 → 定时器被清 → 外层 `await` 永不 settle（`onCheckApi` 后续一行都不执行）；
   * 300ms 内没卸载时 `reject()` 又因调用点在 try 之外而无人接收。两条路径都不是取消的语义。
   */
  const onCancel = () => {
    setOpen(false)
    resolve(null)
  }

  const onClose = () => {
    TopView.hide(TopViewKey)
  }

  return (
    <Modal
      title={i18n.t('message.api.check.model.title', { model: model })}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      transitionName="animation-move-down"
      width={400}
      centered>
      <ModelSelector
        providers={[provider]}
        predicate={modelPredicate}
        grouped={false}
        defaultValue={defaultModelValue}
        placeholder={i18n.t('settings.models.empty')}
        style={{ width: '100%' }}
        onChange={(value) => {
          setModel(models.find((m) => value === getModelUniqId(m)))
        }}
      />
    </Modal>
  )
}

const TopViewKey = 'SelectProviderModelPopup'

export default class SelectProviderModelPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  /** 选中模型 → resolve(model)；取消 → resolve(null)（哨兵，不再 reject）。 */
  static show(props: ShowParams): Promise<Model | null> {
    return new Promise<Model | null>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
