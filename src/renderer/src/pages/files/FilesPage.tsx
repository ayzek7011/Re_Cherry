import { ExclamationCircleOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import ListItem from '@renderer/components/ListItem'
import db from '@renderer/databases'
import { getFileFieldLabel } from '@renderer/i18n/label'
import { handleDelete, handleRename, sortFiles, tempFilesSort } from '@renderer/services/FileAction'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata, FileType } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import { Button, Checkbox, Dropdown, Empty, Flex, Popconfirm, Spin } from 'antd'
import dayjs from 'dayjs'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowDownNarrowWide,
  ArrowUpWideNarrow,
  File as FileIcon,
  FileImage,
  FileText,
  FileType as FileTypeIcon
} from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { runBatchDelete } from './batchDelete'
import FileList from './FileList'

type SortField = 'created_at' | 'size' | 'name'
type SortOrder = 'asc' | 'desc'

const logger = loggerService.withContext('FilesPage')

const FilesPage: FC = () => {
  const { t } = useTranslation()
  // 默认分类由 V1 的「文档」改为「全部」。真机反馈"文件页没把我上传的图片/文档/AI 出图纳入"
  // 有两层原因，这是第二层：出图与上传的图片都归在 image 分类，而打开页面停在 document（多数人没有文档）
  // ⇒ 第一眼是空页。分类本身没坏，默认值改掉即可（想回到 V1 口径只需把这里改回 'document'）。
  const [fileType, setFileType] = useState<FileType | 'all'>('all')
  const [sortField, setSortField] = useState<SortField>('created_at')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])

  useEffect(() => {
    setSelectedFileIds([])
  }, [fileType])

  const files = useLiveQuery<FileMetadata[]>(async () => {
    if (fileType === 'all') {
      return db.files.orderBy('count').toArray().then(tempFilesSort)
    }
    return db.files.where('type').equals(fileType).sortBy('count').then(tempFilesSort)
  }, [fileType])

  // `useLiveQuery` 在首个结果到达前返回 `undefined`（= 加载中），与"查到了 0 行"是两件事。
  // 旧实现两者都落到 `Empty`，每次进文件页先闪一下"暂无数据"。读取异常不走这里
  //（dexie-react-hooks 会在渲染期 throw monitor.current.error），本条只针对"加载中"这一态。
  const isLoading = files === undefined
  const sortedFiles = files ? sortFiles(files, sortField, sortOrder) : []

  const handleBatchDelete = async () => {
    let validFiles: FileMetadata[]
    try {
      const selectedFiles = await Promise.all(selectedFileIds.map((id) => FileManager.getFile(id)))
      validFiles = selectedFiles.filter((file) => file !== null && file !== undefined)
    } catch (error) {
      logger.error('Failed to load the selected files for batch deletion:', error as Error)
      window.toast.error(t('common.delete_failed'))
      return
    }

    if (validFiles.length === 0) {
      setSelectedFileIds([])
      return
    }

    // 逐个删除并收全结果——旧实现用 `Promise.all`，第一个 reject 就整体抛出，
    // 选中态既不清理也不报错；成功/失败也从不计数（要求批量删除报告"N 成功 / M 失败"）。
    const { succeededIds, failures } = await runBatchDelete(
      validFiles.map((file) => file.id),
      (fileId) => handleDelete(fileId, t)
    )

    if (failures.length > 0) {
      logger.error(
        `Batch delete failed for ${failures.length}/${validFiles.length} files:`,
        failures[0].reason as Error
      )
      window.toast.error(t('files.batch_delete_result', { success: succeededIds.length, failed: failures.length }))
      // 失败项保留选中，用户可原地重试；已成功的项不该再被当成待删对象。
      setSelectedFileIds(failures.map((failure) => failure.fileId))
      return
    }

    setSelectedFileIds([])
  }

  const handleSelectFile = (fileId: string, checked: boolean) => {
    if (checked) {
      setSelectedFileIds((prev) => [...prev, fileId])
    } else {
      setSelectedFileIds((prev) => prev.filter((id) => id !== fileId))
    }
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedFileIds(sortedFiles.map((file) => file.id))
    } else {
      setSelectedFileIds([])
    }
  }

  // 定位/打开不得静默吞错（问题2候选2）：openPath 失败（字节缺失/路径坏）此前是
  // unhandled rejection，点击后界面零反馈。路径地基先到位再重建（候选1），失败 toast。
  const handleOpenFile = async (file: FileMetadata) => {
    try {
      await FileManager.syncRuntimePaths()
      await window.api.file.openPath(FileManager.getFilePath(file))
    } catch (error) {
      logger.warn(`Failed to open file ${file.id}`, error as Error)
      window.toast.error(t('files.preview.error'))
    }
  }

  // 这里原来每行一条 `logger.debug('FileItem', file)`（第一个参数是 context 名而非消息）。
  // `dataSource` 没有 memo，每次渲染都会对全部文件跑一遍 map 并刷日志——纯脚手架语句，删除。
  const dataSource = sortedFiles?.map((file) => {
    return {
      key: file.id,
      file: <span onClick={() => handleOpenFile(file)}>{FileManager.formatFileName(file)}</span>,
      size: formatFileSize(file.size),
      size_bytes: file.size,
      count: file.count,
      path: FileManager.getFilePath(file),
      ext: file.ext,
      created_at: dayjs(file.created_at).format('MM-DD HH:mm'),
      created_at_unix: dayjs(file.created_at).unix(),
      actions: (
        <Flex align="center" gap={0} style={{ opacity: 0.7 }}>
          <Button type="text" icon={<EditIcon size={14} />} onClick={() => handleRename(file.id)} />
          <Popconfirm
            title={t('files.delete.title')}
            description={t('files.delete.content')}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            onConfirm={() =>
              // handleDelete 现在会 throw。antd 的 ActionButton 在拒绝分支里 `Promise.reject(e)`，
              // 无人接住即 unhandled rejection。用户可见信号由 handleDelete 给出，这里只留取证行。
              handleDelete(file.id, t).catch((error) => {
                logger.warn(`Failed to delete file ${file.id}`, error as Error)
              })
            }
            placement="left"
            icon={<ExclamationCircleOutlined style={{ color: 'red' }} />}>
            <Button type="text" danger icon={<DeleteIcon size={14} className="lucide-custom" />} />
          </Popconfirm>
          {fileType !== 'image' && (
            <Checkbox
              checked={selectedFileIds.includes(file.id)}
              onChange={(e) => handleSelectFile(file.id, e.target.checked)}
              style={{ margin: '0 8px' }}
            />
          )}
        </Flex>
      )
    }
  })

  const menuItems = [
    { key: FILE_TYPE.DOCUMENT, label: t('files.document'), icon: <FileIcon size={16} /> },
    { key: FILE_TYPE.IMAGE, label: t('files.image'), icon: <FileImage size={16} /> },
    { key: FILE_TYPE.TEXT, label: t('files.text'), icon: <FileTypeIcon size={16} /> },
    { key: 'all', label: t('files.all'), icon: <FileText size={16} /> }
  ] as const

  return (
    <Container>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('files.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <SideNav>
          {menuItems.map((item) => (
            <ListItem
              key={item.key}
              icon={item.icon}
              title={item.label}
              active={fileType === item.key}
              onClick={() => setFileType(item.key)}
            />
          ))}
        </SideNav>
        <MainContent>
          <SortContainer>
            <Flex gap={8} align="center">
              {(['created_at', 'size', 'name'] as const).map((field) => (
                <SortButton
                  key={field}
                  active={sortField === field}
                  onClick={() => {
                    if (sortField === field) {
                      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
                    } else {
                      setSortField(field)
                      setSortOrder('desc')
                    }
                  }}>
                  {getFileFieldLabel(field)}
                  {sortField === field &&
                    (sortOrder === 'desc' ? <ArrowUpWideNarrow size={12} /> : <ArrowDownNarrowWide size={12} />)}
                </SortButton>
              ))}
            </Flex>
            {fileType !== 'image' && (
              <Dropdown.Button
                style={{ width: 'auto' }}
                menu={{
                  items: [
                    {
                      key: 'delete',
                      disabled: selectedFileIds.length === 0,
                      danger: true,
                      label: (
                        <Popconfirm
                          disabled={selectedFileIds.length === 0}
                          title={t('files.delete.title')}
                          description={t('files.delete.content')}
                          okText={t('common.confirm')}
                          cancelText={t('common.cancel')}
                          onConfirm={handleBatchDelete}
                          icon={<ExclamationCircleOutlined style={{ color: 'red' }} />}>
                          {t('files.batch_delete')} ({selectedFileIds.length})
                        </Popconfirm>
                      )
                    }
                  ]
                }}
                trigger={['click']}>
                <Checkbox
                  indeterminate={selectedFileIds.length > 0 && selectedFileIds.length < sortedFiles.length}
                  checked={selectedFileIds.length === sortedFiles.length && sortedFiles.length > 0}
                  onChange={(e) => handleSelectAll(e.target.checked)}>
                  {t('files.batch_operation')}
                </Checkbox>
              </Dropdown.Button>
            )}
          </SortContainer>
          {isLoading ? (
            <LoadingPlaceholder data-testid="files-loading">
              <Spin />
            </LoadingPlaceholder>
          ) : dataSource && dataSource.length > 0 ? (
            <FileList id={fileType} list={dataSource} files={sortedFiles} />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </MainContent>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
`

const MainContent = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
`

const SortContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 0.5px solid var(--color-border);
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 100%;
`

const SideNav = styled.div`
  display: flex;
  flex-direction: column;
  width: var(--settings-width);
  border-right: 0.5px solid var(--color-border);
  padding: 12px 10px;
  user-select: none;
  gap: 6px;

  .ant-menu {
    border-inline-end: none !important;
    background: transparent;
  }

  .ant-menu-item {
    height: 36px;
    line-height: 36px;
    margin: 4px 0;
    width: 100%;
    border-radius: var(--list-item-border-radius);
    border: 0.5px solid transparent;

    &:hover {
      background-color: var(--color-background-soft) !important;
    }

    &.ant-menu-item-selected {
      background-color: var(--color-background-soft);
      color: var(--color-primary);
      border: 0.5px solid var(--color-border);
    }
  }
`

const LoadingPlaceholder = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
`

const SortButton = styled(Button)<{ active?: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  height: 30px;
  border-radius: var(--list-item-border-radius);
  border: 0.5px solid ${(props) => (props.active ? 'var(--color-border)' : 'transparent')};
  background-color: ${(props) => (props.active ? 'var(--color-background-soft)' : 'transparent')};
  color: ${(props) => (props.active ? 'var(--color-text)' : 'var(--color-text-secondary)')};

  &:hover {
    background-color: var(--color-background-soft);
    color: var(--color-text);
  }

  .anticon {
    font-size: 12px;
  }
`

export default FilesPage
