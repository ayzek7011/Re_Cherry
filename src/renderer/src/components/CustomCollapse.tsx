import { Collapse } from 'antd'
import { merge } from 'lodash-es'
import { ChevronRight } from 'lucide-react'
import type { FC } from 'react'
import { memo, useMemo, useState } from 'react'

interface CustomCollapseProps {
  label: React.ReactNode
  extra: React.ReactNode
  children: React.ReactNode
  destroyInactivePanel?: boolean
  defaultActiveKey?: string[]
  activeKey?: string[]
  collapsible?: 'header' | 'icon' | 'disabled'
  onChange?: (activeKeys: string | string[]) => void
  style?: React.CSSProperties
  styles?: {
    header?: React.CSSProperties
    body?: React.CSSProperties
  }
}

const CustomCollapse: FC<CustomCollapseProps> = ({
  label,
  extra,
  children,
  destroyInactivePanel = false,
  defaultActiveKey = ['1'],
  activeKey,
  collapsible = undefined,
  onChange,
  style,
  styles
}) => {
  // 局部 state 原来只做「初始镜像」且永不更新，于是 `getHeaderStyle()` 永远返回初始那一支：
  // 用户手点折叠头展开一个初始收起的面板时，头部仍保留四角圆角，而 body 已展开贴上。
  // 现在按「受控 / 非受控」分开：受控时圆角由 `activeKey` 推导，非受控时由本组件的 state 推导。
  const isControlled = activeKey !== undefined
  const [uncontrolledActiveKeys, setUncontrolledActiveKeys] = useState<string[]>(defaultActiveKey)
  const effectiveActiveKeys = isControlled ? activeKey : uncontrolledActiveKeys

  const defaultCollapseStyle = {
    width: '100%',
    background: 'transparent',
    border: '0.5px solid var(--color-border)'
  }

  const defaultCollpaseHeaderStyle = {
    padding: '3px 16px',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--color-background-soft)'
  }

  const getHeaderStyle = () => {
    return effectiveActiveKeys && effectiveActiveKeys.length > 0
      ? {
          ...defaultCollpaseHeaderStyle,
          borderTopLeftRadius: '8px',
          borderTopRightRadius: '8px'
        }
      : {
          ...defaultCollpaseHeaderStyle,
          borderRadius: '8px'
        }
  }

  const defaultCollapseItemStyles = {
    header: getHeaderStyle(),
    body: {
      borderTop: 'none'
    }
  }

  const collapseStyle = merge({}, defaultCollapseStyle, style)
  const collapseItemStyles = useMemo(() => {
    return merge({}, defaultCollapseItemStyles, styles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveActiveKeys])

  return (
    <Collapse
      bordered={false}
      style={collapseStyle}
      defaultActiveKey={isControlled ? undefined : defaultActiveKey}
      activeKey={activeKey}
      destroyOnHidden={destroyInactivePanel}
      collapsible={collapsible}
      onChange={(keys) => {
        if (!isControlled) {
          setUncontrolledActiveKeys(Array.isArray(keys) ? keys : [keys])
        }
        onChange?.(keys)
      }}
      expandIcon={({ isActive }) => (
        <ChevronRight
          size={16}
          color="var(--color-text-3)"
          strokeWidth={1.5}
          style={{ transform: isActive ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
      )}
      items={[
        {
          styles: collapseItemStyles,
          key: '1',
          label,
          extra,
          children
        }
      ]}
    />
  )
}

export default memo(CustomCollapse)
