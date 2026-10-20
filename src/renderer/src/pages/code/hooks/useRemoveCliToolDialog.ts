import type { CodeCli } from '@shared/types/codeCli'
import type { ComponentProps } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ConfirmDialog } from '../components/shadcn'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useRemoveCliToolDialog.ts
//（2026-09-24）。逐字；import 面对号：ConfirmDialog 类型 ← 本页 shim
//（fork 无 @cherrystudio/ui）、CodeCli ← @shared/types/codeCli。

interface RemoveCliToolDialogController {
  removeDialogProps: ComponentProps<typeof ConfirmDialog>
  requestRemove: (tool: CodeCli) => void
}

export function useRemoveCliToolDialog({
  toolName,
  remove
}: {
  toolName: string
  /** True when the tool is actually gone; false keeps the dialog open for an in-place retry. */
  remove: (tool: CodeCli) => Promise<boolean>
}): RemoveCliToolDialogController {
  const { t } = useTranslation()
  const [removeTarget, setRemoveTarget] = useState<CodeCli | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  return {
    removeDialogProps: {
      open: !!removeTarget,
      onOpenChange: (open) => !open && setRemoveTarget(null),
      title: t('settings.dependencies.uninstallConfirmTitle'),
      description: t('settings.dependencies.uninstallConfirmMessage', { name: toolName }),
      cancelText: t('common.cancel'),
      confirmText: t('common.confirm'),
      destructive: true,
      confirmLoading: isRemoving,
      onConfirm: async () => {
        if (!removeTarget) return

        setIsRemoving(true)
        try {
          const removed = await remove(removeTarget)
          // （用户裁决）：卸载完成后关闭确认窗——原实现只复位 isRemoving，
          // 窗口停在已完成的确认态。失败时保留窗口便于就地重试（错误行常驻渲染）。
          if (removed) setRemoveTarget(null)
        } finally {
          setIsRemoving(false)
        }
      }
    },
    requestRemove: setRemoveTarget
  }
}
