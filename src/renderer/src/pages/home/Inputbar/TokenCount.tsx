import { HStack, VStack } from '@renderer/components/Layout'
import { useSettings } from '@renderer/hooks/useSettings'
import { Popover } from 'antd'
import { MenuIcon } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

type Props = {
  estimateTokenCount: number
  inputTokenCount: number
} & React.HTMLAttributes<HTMLDivElement>

const TokenCount: FC<Props> = ({ estimateTokenCount, inputTokenCount }) => {
  const { t } = useTranslation()
  const { showInputEstimatedTokens } = useSettings()

  if (!showInputEstimatedTokens) {
    return null
  }

  const PopoverContent = () => {
    return (
      <VStack w="185px" background="100%">
        <HStack justifyContent="space-between" w="100%">
          <Text>{t('chat.input.estimated_tokens.tip')}</Text>
          <Text>{estimateTokenCount}</Text>
        </HStack>
      </VStack>
    )
  }

  return (
    <Container>
      <Popover content={PopoverContent} arrow={false}>
        <HStack>
          <HStack style={{ alignItems: 'center' }}>
            <MenuIcon size={12} className="icon" />
            {inputTokenCount}
            <SlashSeparatorSpan>/</SlashSeparatorSpan>
            {estimateTokenCount}
          </HStack>
        </HStack>
      </Popover>
    </Container>
  )
}

const Container = styled.div`
  font-size: 11px;
  line-height: 16px;
  color: var(--color-text-2);
  z-index: 10;
  padding: 3px 10px;
  user-select: none;
  border-radius: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;
  .icon {
    margin-right: 3px;
  }
  @media (max-width: 800px) {
    display: none;
  }
`

const Text = styled.div`
  font-size: 12px;
  color: var(--color-text-1);
`

const SlashSeparatorSpan = styled.span`
  margin-left: 2px;
  margin-right: 2px;
`

export default TokenCount
