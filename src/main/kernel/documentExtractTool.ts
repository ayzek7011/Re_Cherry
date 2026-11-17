/**
 * documents_extract 外置工具（工作模式；2026-10-21 用户裁决）。
 *
 * 背景：read_document/ocr_document 被"每轮附件登记"钉在附件线上（触发消息 FILE 附件
 * 才挂载、按登记名读）——磁盘上的文档文件两个老工具都够不着。本工具承担**磁盘线**：
 * 按绝对路径抽取文档文字，与附件线同权（读与 dsh-tool-fs 的 read 同约束——读不经
 * 沙箱档位/审批编舞，那套管写面；无路径白名单，用户裁决"不是需要特殊考虑的问题"）。
 *
 * 一个工具两条引擎（模型显式选 engine，不设自动兜底——文档处理臂一跑数分钟加费用，
 * 自动降级正是要杜绝的静默退化）：
 * - markitdown 臂（缺省）：原生文本层管线，与附件读共用 extractFromFile——快、零成本；
 * - document_processing 臂：文档处理通道（本地 Paddle / 云解析），专治扫描件——慢、
 *   贵、PDF-only，OCR 内核与 ocrTurnDocument 共用（ocrDocumentAtPath）。
 *
 * 挂载：EXTERNAL_TOOL_IDS 常驻外置（工作模式 + 助手开关，与 fs/pwsh 同机制）；服务
 * 商前提随本轮 preprocess 登记上行（渲染层载荷门 = OCR 能力合并挂载门，严格同形）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { knowledgeService } from '../services/knowledge/KnowledgeService'

const logger = loggerService.withContext('DocumentExtractTool')

export const name = 'tool-documents-extract'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  'Extract text from a document file on disk by absolute path. Two engines: "markitdown" reads the text layer ' +
  'natively (pdf, doc, docx, pptx, xlsx, odt, odp, ods, epub, html and text files) — fast and free. ' +
  '"document_processing" parses scanned PDFs through the configured document-processing provider — slow, costly ' +
  'and PDF-only. The default engine is "markitdown"; switch to "document_processing" only when the text layer ' +
  'comes back empty or garbled. For attached conversation documents, use read_document by name instead.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'documents_extract',
      description: DESCRIPTION,
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path of the document file on disk.'
        },
        engine: {
          type: 'string',
          description:
            'Extraction engine. "markitdown" (default) reads the text layer natively. "document_processing" runs ' +
            'the configured document-processing provider for scanned PDFs (PDF only; takes minutes).'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            document: { type: 'string', required: true },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      // document_processing 是重活（分钟级 OCR/云解析，与 ocr_document 同款）——该臂
      // 串行；markitdown 臂是快速读取，可并行。按本次调用的 engine 参数判定。
      isConcurrencySafe: (args) => {
        const source = typeof args === 'object' && args !== null ? (args as { engine?: unknown }) : undefined
        return source?.engine !== 'document_processing'
      },
      async execute(args, exec) {
        const filePath = String(args.path ?? '').trim()
        if (filePath.length === 0) {
          throw new Error('documents_extract: empty file path')
        }
        const engine = args.engine === undefined ? 'markitdown' : String(args.engine)
        if (engine !== 'markitdown' && engine !== 'document_processing') {
          throw new Error(`documents_extract: unknown engine "${engine}"`)
        }
        if (engine === 'document_processing') {
          const topicId = exec.agent?.session?.id
          if (topicId === undefined) {
            throw new Error('documents_extract: no active conversation turn')
          }
          const result = await knowledgeService.processDocumentFromDisk(topicId, filePath, exec.signal)
          logger.info(`documents_extract: "${filePath}" -> ${result.text.length} chars (document_processing)`)
          return { document: result.name, text: result.text }
        }
        const result = await knowledgeService.readDocumentFromDisk(filePath, exec.signal)
        logger.info(`documents_extract: "${filePath}" -> ${result.text.length} chars (markitdown)`)
        return { document: result.name, text: result.text }
      }
    })
  )
}
