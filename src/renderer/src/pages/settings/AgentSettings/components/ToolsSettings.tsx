import type { Assistant } from '@renderer/types'
import {
  BUILTIN_TOOL_IDS,
  type BuiltinToolId,
  EXTERNAL_TOOL_IDS,
  type ExternalToolId,
  TOOL_ORIGIN_NAMES,
  type ToolPageCardId
} from '@shared/config/agentTools'
import { Switch } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingsContainer, SettingsItem, SettingsTitle } from '../shared'

interface Props {
  assistant: Assistant
  updateAssistant: (update: Partial<Omit<Assistant, 'id'>>) => void
}

/**
 * 一张卡片要用的两条文案键：i18n 工具名 / 介绍。
 * 原版名不是文案（标识符），从 `TOOL_ORIGIN_NAMES` 取。逐条显式写出键、不用模板字面量拼，
 * 以通过 i18n 静态键检查。
 */
interface ToolCopyKeys {
  name: string
  description: string
}

// 键类型写死成 id 联合（`TOOL_ORIGIN_NAMES` 同款写法），注册表新增工具时
// 这两张表不补就**编译失败**；旧写法 `Record<string, …>` 会让漏项先编译通过，再在
// 渲染期以 `copyMap[toolId]` 为 undefined 抛 TypeError。
const BUILTIN_TOOL_COPY: Record<BuiltinToolId, ToolCopyKeys> = {
  ask_user_question: {
    name: 'settings.agentSettings.tools.builtins.ask.name',
    description: 'settings.agentSettings.tools.builtins.ask.description'
  },
  ocr_document: {
    name: 'settings.agentSettings.tools.builtins.ocr.name',
    description: 'settings.agentSettings.tools.builtins.ocr.description'
  }
}

const EXTERNAL_TOOL_COPY: Record<ExternalToolId, ToolCopyKeys> = {
  fs: {
    name: 'settings.agentSettings.tools.externals.fs.name',
    description: 'settings.agentSettings.tools.externals.fs.description'
  },
  fsSearch: {
    name: 'settings.agentSettings.tools.externals.fsSearch.name',
    description: 'settings.agentSettings.tools.externals.fsSearch.description'
  },
  editor: {
    name: 'settings.agentSettings.tools.externals.editor.name',
    description: 'settings.agentSettings.tools.externals.editor.description'
  },
  pwsh: {
    name: 'settings.agentSettings.tools.externals.pwsh.name',
    description: 'settings.agentSettings.tools.externals.pwsh.description'
  },
  jobs: {
    name: 'settings.agentSettings.tools.externals.jobs.name',
    description: 'settings.agentSettings.tools.externals.jobs.description'
  },
  trash: {
    name: 'settings.agentSettings.tools.externals.trash.name',
    description: 'settings.agentSettings.tools.externals.trash.description'
  },
  saveAttachment: {
    name: 'settings.agentSettings.tools.externals.saveAttachment.name',
    description: 'settings.agentSettings.tools.externals.saveAttachment.description'
  },
  documentsExtract: {
    name: 'settings.agentSettings.tools.externals.documentsExtract.name',
    description: 'settings.agentSettings.tools.externals.documentsExtract.description'
  },
  memory: {
    name: 'settings.agentSettings.tools.externals.memory.name',
    description: 'settings.agentSettings.tools.externals.memory.description'
  },
  todo: {
    name: 'settings.agentSettings.tools.externals.todo.name',
    description: 'settings.agentSettings.tools.externals.todo.description'
  },
  goal: {
    name: 'settings.agentSettings.tools.externals.goal.name',
    description: 'settings.agentSettings.tools.externals.goal.description'
  }
}

/** 生图不走 tools 开关映射（助手字段 enableGenerateImage），故单独一条。 */
const GENERATE_IMAGE_COPY: ToolCopyKeys = {
  name: 'settings.agentSettings.tools.builtins.generate_image.name',
  description: 'settings.agentSettings.tools.builtins.generate_image.description'
}

/**
 * 方形卡片正文：第一排 i18n 工具名 + 开关，第二排工具原版名（字略小），下面是介绍。
 *
 * 抽成模块级组件而不是内联两遍：内置组的生图卡片走的是助手字段而非 tools 映射，
 * 但三排版式必须完全一致，否则两类卡片会长得不一样。
 */
const ToolCardBody: FC<{
  cardId: ToolPageCardId
  copy: ToolCopyKeys
  checked: boolean
  onToggle: (enabled: boolean) => void
}> = ({ cardId, copy, checked, onToggle }) => {
  const { t } = useTranslation()

  return (
    <>
      <ToolCardHead>
        <ToolName>{t(copy.name)}</ToolName>
        {/* 卡片整体可点是老行为，指针停在开关上时不要连带触发一次卡片点击（= 反向再切一次）。 */}
        <Switch size="small" checked={checked} onClick={(_, event) => event.stopPropagation()} onChange={onToggle} />
      </ToolCardHead>
      <ToolOrigin>{TOOL_ORIGIN_NAMES[cardId]}</ToolOrigin>
      <ToolDescription>{t(copy.description)}</ToolDescription>
    </>
  )
}

/**
 * 工具页（验收设计；卡片为方形三排：名+开关 / 原版名 / 介绍）：两组工具各带开关
 * （稀疏 map 缺省 = 开，默认全开），拨动下一轮对话生效。内置工具（@shared/config/agentTools）
 * 未开启工作模式也可用；外置工具仅工作模式开启时挂载；审批三档在「权限模式」页
 * （单一数据源单一编辑点）。
 */
const ToolsSettings: FC<Props> = ({ assistant, updateAssistant }) => {
  const { t } = useTranslation()

  const isEnabled = (map: Record<string, boolean> | undefined, toolId: string): boolean => map?.[toolId] !== false

  const handleToggle = (field: 'builtinTools' | 'externalTools', toolId: string, enabled: boolean) => {
    updateAssistant({ [field]: { ...assistant[field], [toolId]: enabled } })
  }

  // 泛型把 entries 与 copyMap 钉成同一套 id：两张表各自是**完整**的（`Record<BuiltinToolId>` /
  // `Record<ExternalToolId>`），漏登记就编译失败，而不是取到 undefined 再渲染期抛错。
  const renderToolGrid = <Id extends ToolPageCardId>(
    field: 'builtinTools' | 'externalTools',
    entries: readonly Id[],
    copyMap: Record<Id, ToolCopyKeys>
  ) => (
    <ToolGrid>
      {entries.map((toolId) => {
        const checked = isEnabled(assistant[field], toolId)
        return (
          <ToolCard key={toolId} onClick={() => handleToggle(field, toolId, !checked)}>
            <ToolCardBody
              cardId={toolId}
              copy={copyMap[toolId]}
              checked={checked}
              onToggle={(enabled) => handleToggle(field, toolId, enabled)}
            />
          </ToolCard>
        )
      })}
    </ToolGrid>
  )

  return (
    <SettingsContainer>
      <SettingsItem divider={false}>
        <SettingsTitle>{t('settings.agentSettings.tools.builtinTitle')}</SettingsTitle>
        {renderToolGrid('builtinTools', BUILTIN_TOOL_IDS, BUILTIN_TOOL_COPY)}
        {/* 双门：assistant.enableGenerateImage（工具面）+ llm.paintingModel（模型面）。
            模型面在**设置页**配置（V2 的 feature.paintings.default_model_id 语义），绘画页只读它
            播种新草稿、不再写全局值。
            fork 缝：绘画模型选择器不在此处——已移到「设置 › 默认模型 › 绘画模型」
            （ModelSettings.tsx，llm.paintingModel 单一编辑点），本页只留工具面开关。
            原先此处挂过一条「选择绘画模型后才会挂载」的小字，已删：同样的前提写在卡片自己的
            介绍里（`…generate_image.description`），框外再挂一条只是重复。 */}
        <ToolGrid>
          <ToolCard onClick={() => updateAssistant({ enableGenerateImage: !assistant.enableGenerateImage })}>
            <ToolCardBody
              cardId="generate_image"
              copy={GENERATE_IMAGE_COPY}
              checked={assistant.enableGenerateImage === true}
              onToggle={(enabled) => updateAssistant({ enableGenerateImage: enabled })}
            />
          </ToolCard>
        </ToolGrid>
      </SettingsItem>

      <SettingsItem divider={false}>
        <SettingsTitle>{t('settings.agentSettings.tools.externalTitle')}</SettingsTitle>
        {renderToolGrid('externalTools', EXTERNAL_TOOL_IDS, EXTERNAL_TOOL_COPY)}
      </SettingsItem>

      <SettingsItem divider={false}>
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          {t('settings.agentSettings.tools.placeholder')}
        </span>
      </SettingsItem>
    </SettingsContainer>
  )
}

/**
 * 方形卡片网格：定宽 180px（沿用改造前那张小卡片的宽度，间距/内边距也回到它的 8px / 10px 12px），
 * 不用 `1fr` 拉伸——面板宽时两个内置工具会被拉成巨块，方形卡片一旦随宽度走尺寸就不可预期。
 */
const ToolGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, 180px);
  gap: 8px;
  width: 100%;
`

/** 正方形卡片：三排内容自上而下，多余空间留底部（`aspect-ratio` 定死方块）。 */
const ToolCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  aspect-ratio: 1 / 1;
  padding: 10px 12px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.2s;

  &:hover {
    border-color: var(--color-primary);
  }
`

const ToolCardHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const ToolName = styled.span`
  overflow: hidden;
  color: var(--color-text-1);
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ToolOrigin = styled.span`
  overflow: hidden;
  color: var(--color-text-3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ToolDescription = styled.p`
  margin: 0;
  overflow: hidden;
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.5;
`

export default ToolsSettings
