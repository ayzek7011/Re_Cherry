import { SearchOutlined } from '@ant-design/icons'
import { VStack } from '@renderer/components/Layout'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { selectAllTopics } from '@renderer/store/assistants'
import type { Topic } from '@renderer/types'
import { Button, Divider, Empty, Segmented } from 'antd'
import dayjs from 'dayjs'
import { groupBy, isEmpty, orderBy } from 'lodash-es'
import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

type SortType = 'createdAt' | 'updatedAt'

type Props = {
  keywords: string
  /** 选中话题。名字不叫 `onClick`：`React.HTMLAttributes` 里已有一个鼠标事件版本的 `onClick`，
   * 两者交叉成一个不可能满足的类型（父组件此前只能靠 `as any` 绕过）。 */
  onTopicClick: (topic: Topic) => void
  onSearch: () => void
} & React.HTMLAttributes<HTMLDivElement>

const TopicsHistory: React.FC<Props> = ({ keywords, onTopicClick, onSearch, ...props }) => {
  const { t } = useTranslation()
  const { handleScroll, containerRef } = useScrollPosition('TopicsHistory')
  const [sortType, setSortType] = useState<SortType>('createdAt')

  // FIXME: db 中没有 topic.name 等信息，只能从 store 获取
  const topics = useSelector(selectAllTopics)

  // 全量扫描只随输入/排序变化重算：本组件已 memo，但面板自身的任何重渲染
  // （消息加载、滚动容器变化）都不该再跑一次 filter + orderBy + groupBy + dayjs。
  const filteredTopics = useMemo(
    () => topics.filter((topic) => topic.name.toLowerCase().includes(keywords.toLowerCase())),
    [topics, keywords]
  )

  const groupedTopics = useMemo(
    () =>
      groupBy(orderBy(filteredTopics, sortType, 'desc'), (topic) => {
        return dayjs(topic[sortType]).format('MM/DD')
      }),
    [filteredTopics, sortType]
  )

  if (isEmpty(filteredTopics)) {
    return (
      <ListContainer {...props}>
        <VStack alignItems="center">
          <Empty description={t('history.search.topics.empty')} />
          <Button style={{ width: 200, marginTop: 20 }} type="primary" onClick={onSearch} icon={<SearchOutlined />}>
            {t('history.search.messages')}
          </Button>
        </VStack>
      </ListContainer>
    )
  }

  return (
    <ListContainer {...props} ref={containerRef} onScroll={handleScroll}>
      <Segmented
        shape="round"
        size="small"
        value={sortType}
        onChange={setSortType}
        options={[
          { label: t('export.created'), value: 'createdAt' },
          { label: t('export.last_updated'), value: 'updatedAt' }
        ]}
      />
      <ContainerWrapper>
        {Object.entries(groupedTopics).map(([date, items]) => (
          <ListItem key={date}>
            <Date>{date}</Date>
            <Divider style={{ margin: '5px 0' }} />
            {items.map((topic) => (
              <TopicItem key={topic.id} onClick={() => onTopicClick(topic)}>
                <TopicName>{topic.name.substring(0, 50)}</TopicName>
                <TopicDate>{dayjs(topic[sortType]).format('HH:mm')}</TopicDate>
              </TopicItem>
            ))}
          </ListItem>
        ))}
        {keywords && (
          <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
            <Button style={{ width: 200, marginTop: 20 }} type="primary" onClick={onSearch} icon={<SearchOutlined />}>
              {t('history.search.messages')}
            </Button>
          </div>
        )}
        <div style={{ minHeight: 30 }}></div>
      </ContainerWrapper>
    </ListContainer>
  )
}

const ContainerWrapper = styled.div`
  width: 100%;
  padding: 0 16px;
  display: flex;
  flex-direction: column;
`

const ListContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow-y: scroll;
  width: 100%;
  align-items: center;
  padding-top: 10px;
  padding-bottom: 20px;
`

const ListItem = styled.div`
  display: flex;
  flex-direction: column;
  margin-bottom: 15px;
`

const Date = styled.div`
  font-size: 26px;
  font-weight: bold;
  color: var(--color-text-3);
`

const TopicItem = styled.div`
  cursor: pointer;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  height: 30px;
`

const TopicName = styled.div`
  font-size: 14px;
  color: var(--color-text);
`

const TopicDate = styled.div`
  font-size: 14px;
  color: var(--color-text-3);
  margin-left: 10px;
`

// memo：父组件 HistoryPage 每敲一个字符都会重渲染，本组件否则要跟着全量重排一次。
export default memo(TopicsHistory)
