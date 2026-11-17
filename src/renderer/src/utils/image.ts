import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import { parseDataUrl } from '@shared/utils'
import * as htmlToImage from 'html-to-image'
import { Base64 } from 'js-base64'
import mime from 'mime'

const logger = loggerService.withContext('Utils:image')

/**
 * 将文件转换为 Base64 编码的字符串或 ArrayBuffer。
 * @param {File} file 要转换的文件
 * @returns {Promise<string | ArrayBuffer | null>} 转换后的 Base64 编码数据，如果出错则返回 null
 */
export const convertToBase64 = (file: File): Promise<string | ArrayBuffer | null> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * 压缩图像文件，限制最大大小和尺寸。
 * @param {File} file 要压缩的图像文件
 * @returns {Promise<File>} 压缩后的图像文件
 */
export const compressImage = async (file: File): Promise<File> => {
  // browser-image-compression 动态装载（问题5 #5）：低频路径不进首屏静态图
  // （懒加载先例 exportBackends.ts:723）。
  const { default: imageCompression } = await import('browser-image-compression')
  return await imageCompression(file, {
    maxSizeMB: 1,
    maxWidthOrHeight: 300,
    useWebWorker: false
  })
}

/**
 * 捕获指定元素的图像数据。
 * @param elRef 元素的引用
 * @returns Promise<string | undefined> 图像数据 URL，如果失败则返回 undefined
 */
export async function captureElement(elRef: React.RefObject<HTMLElement>) {
  if (elRef.current) {
    try {
      const canvas = await htmlToImage.toCanvas(elRef.current)
      const imageData = canvas.toDataURL('image/png')
      return imageData
    } catch (error) {
      logger.error('Error capturing element:', error as Error)
      return Promise.reject()
    }
  }
  return Promise.resolve(undefined)
}

/**
 * 捕获可滚动元素的完整内容图像。
 * @param elRef 可滚动元素的引用
 * @returns Promise<HTMLCanvasElement | undefined> 捕获的画布对象，如果失败则返回 undefined
 */
export const captureScrollable = async (elRef: React.RefObject<HTMLElement | null>) => {
  if (elRef.current) {
    try {
      const el = elRef.current

      // Save original styles
      const originalStyle = {
        height: el.style.height,
        maxHeight: el.style.maxHeight,
        overflow: el.style.overflow,
        position: el.style.position
      }

      const originalScrollTop = el.scrollTop

      // Hide scrollbars during capture
      el.classList.add('hide-scrollbar')

      // Modify styles to show full content
      el.style.height = 'auto'
      el.style.maxHeight = 'none'
      el.style.overflow = 'visible'
      el.style.position = 'static'

      // calculate the size of the element
      const totalWidth = el.scrollWidth
      const totalHeight = el.scrollHeight

      // check if the size of the element is too large
      const MAX_ALLOWED_DIMENSION = 32767 // the maximum allowed pixel size
      if (totalHeight > MAX_ALLOWED_DIMENSION || totalWidth > MAX_ALLOWED_DIMENSION) {
        // restore the original styles
        el.style.height = originalStyle.height
        el.style.maxHeight = originalStyle.maxHeight
        el.style.overflow = originalStyle.overflow
        el.style.position = originalStyle.position

        // restore the original scroll position
        setTimeout(() => {
          el.scrollTop = originalScrollTop
        }, 0)

        window.toast.error(i18n.t('message.error.dimension_too_large'))
        return Promise.reject()
      }

      const filterHiddenElements = (node: Node) => {
        if (node instanceof HTMLElement) {
          if (node.style.display === 'none') {
            return false
          }
          if (window.getComputedStyle(node).display === 'none') {
            return false
          }
        }
        return true
      }

      const canvas = await new Promise<HTMLCanvasElement>((resolve, reject) => {
        htmlToImage
          .toCanvas(el, {
            filter: filterHiddenElements,
            backgroundColor: getComputedStyle(el).getPropertyValue('--color-background'),
            cacheBust: true,
            pixelRatio: window.devicePixelRatio,
            skipAutoScale: true,
            canvasWidth: el.scrollWidth,
            canvasHeight: el.scrollHeight,
            style: {
              backgroundColor: getComputedStyle(el).backgroundColor,
              color: getComputedStyle(el).color
            }
          })
          .then((canvas) => resolve(canvas))
          .catch((error) => reject(error))
      })

      // Restore original styles
      el.style.height = originalStyle.height
      el.style.maxHeight = originalStyle.maxHeight
      el.style.overflow = originalStyle.overflow
      el.style.position = originalStyle.position

      const imageData = canvas

      // Restore original scroll position
      setTimeout(() => {
        el.scrollTop = originalScrollTop
      }, 0)

      return imageData
    } catch (error) {
      logger.error('Error capturing scrollable element:', error as Error)
      throw error
    } finally {
      // Remove scrollbar hiding class
      elRef.current?.classList.remove('hide-scrollbar')
    }
  }

  return Promise.resolve(undefined)
}

/**
 * 将可滚动元素的图像数据转换为 Data URL 格式。
 * @param elRef 可滚动元素的引用
 * @returns Promise<string | undefined> 图像数据 URL，如果失败则返回 undefined
 */
export const captureScrollableAsDataURL = async (elRef: React.RefObject<HTMLElement | null>) => {
  return captureScrollable(elRef).then((canvas) => {
    if (canvas) {
      return canvas.toDataURL('image/png')
    }
    return Promise.resolve(undefined)
  })
}

/**
 * 将可滚动元素的图像数据转换为 Blob 格式。
 * @param elRef 可滚动元素的引用
 * @param func Blob 回调函数
 * @returns Promise<void> 处理结果
 */
export const captureScrollableAsBlob = async (elRef: React.RefObject<HTMLElement | null>, func: BlobCallback) => {
  await captureScrollable(elRef).then((canvas) => {
    canvas?.toBlob(func, 'image/png')
  })
}

/**
 * 捕获 iframe 内部文档的完整内容快照
 */
export const svgToCanvas = (svgElement: SVGElement, scale = 3): Promise<HTMLCanvasElement> => {
  // 获取 SVG 尺寸信息
  const viewBox = svgElement.getAttribute('viewBox')?.split(' ').map(Number) || []
  const rect = svgElement.getBoundingClientRect()
  const width = viewBox[2] || svgElement.clientWidth || rect.width
  const height = viewBox[3] || svgElement.clientHeight || rect.height

  // 序列化 SVG 内容
  const svgData = new XMLSerializer().serializeToString(svgElement)

  let svgBase64: string
  try {
    // 使用 TextEncoder 处理 Unicode 字符
    const encoder = new TextEncoder()
    const encodedData = encoder.encode(svgData)
    const binaryString = Array.from(encodedData, (byte) => String.fromCodePoint(byte)).join('')
    svgBase64 = `data:image/svg+xml;base64,${btoa(binaryString)}`
  } catch (error) {
    logger.warn('TextEncoder method failed, falling back to legacy method', error as Error)
    svgBase64 = `data:image/svg+xml;base64,${btoa(decodeURIComponent(encodeURIComponent(svgData)))}`
  }

  // 创建 Canvas
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    return Promise.reject(new Error('Failed to get canvas context'))
  }

  canvas.width = width * scale
  canvas.height = height * scale

  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      try {
        ctx.scale(scale, scale)
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas)
      } catch (error) {
        reject(new Error(`Failed to draw image on canvas: ${error}`))
      }
    }

    img.onerror = () => {
      reject(new Error('Failed to load SVG image'))
    }

    img.src = svgBase64
  })
}

/**
 * 将 SVG 元素转换为 PNG 格式的 Blob。
 * @param svgElement 要转换的 SVG 元素
 * @param scale 缩放比例
 * @returns {Promise<Blob>} 转换后的 PNG Blob
 */
export const svgToPngBlob = (svgElement: SVGElement, scale = 3): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    svgToCanvas(svgElement, scale)
      .then((canvas) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob)
          } else {
            reject(new Error('Failed to create blob from canvas'))
          }
        }, 'image/png')
      })
      .catch(reject)
  })
}

/**
 * 将 SVG 元素转换为 SVG 格式的 Blob。
 * @param svgElement 要转换的 SVG 元素
 * @returns {Blob} 转换后的 SVG Blob
 */
export const svgToSvgBlob = (svgElement: SVGElement): Blob => {
  const svgData = new XMLSerializer().serializeToString(svgElement)
  return new Blob([svgData], { type: 'image/svg+xml' })
}

/**
 * 使用离屏容器测量 DOM 元素的渲染尺寸
 * @param element 要测量的元素
 * @returns 渲染元素的宽度和高度（以像素为单位）
 */
function measureElementSize(element: Element): { width: number; height: number } {
  const clone = element.cloneNode(true) as Element

  // 检查元素类型并重置样式
  if (clone instanceof HTMLElement || clone instanceof SVGElement) {
    clone.style.width = ''
    clone.style.height = ''
    clone.style.position = ''
    clone.style.visibility = ''
  }

  // 创建一个离屏容器
  const container = document.createElement('div')
  container.style.position = 'absolute'
  container.style.top = '-9999px'
  container.style.left = '-9999px'
  container.style.visibility = 'hidden'

  container.appendChild(clone)
  document.body.appendChild(container)

  // 测量并清理
  const rect = clone.getBoundingClientRect()
  document.body.removeChild(container)

  return { width: rect.width, height: rect.height }
}

/**
 * 让 SVG 元素在容器内可缩放，用于“预览”功能。
 * - 补充缺失的 viewBox
 * - 补充缺失的 max-width style
 * - 把 width 改为 100%
 * - 移除 height
 */
export const makeSvgSizeAdaptive = (element: Element): Element => {
  // type guard
  if (!(element instanceof SVGElement)) {
    return element
  }

  const hasViewBox = element.hasAttribute('viewBox')
  const widthStr = element.getAttribute('width')

  let measuredWidth: number | undefined

  // 如果缺少 viewBox 属性，测量元素尺寸来创建
  if (!hasViewBox) {
    const renderedSize = measureElementSize(element)
    if (renderedSize.width > 0 && renderedSize.height > 0) {
      measuredWidth = renderedSize.width
      element.setAttribute('viewBox', `0 0 ${renderedSize.width} ${renderedSize.height}`)
    }
  }

  // 如果没有则设置 max-width
  // 优先使用测量得到的宽度值，否则回退到 width 属性值
  if (!element.style.getPropertyValue('max-width')) {
    if (measuredWidth !== undefined) {
      element.style.setProperty('max-width', `${measuredWidth}px`)
    } else if (widthStr) {
      element.style.setProperty('max-width', widthStr)
    }
  }

  // 调整 width 和 height
  element.setAttribute('width', '100%')
  element.removeAttribute('height')

  // FIXME: 移除 preserveAspectRatio 来避免某些图无法正常预览
  element.removeAttribute('preserveAspectRatio')

  return element
}

/**
 * 将图片 Blob 转换为 PNG 格式的 Blob
 * @param blob 原始图片 Blob
 * @returns Promise<Blob> 转换后的 PNG Blob
 */
export const convertImageToPng = async (blob: Blob): Promise<Blob> => {
  if (blob.type === 'image/png') {
    return blob
  }

  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')

        if (!ctx) {
          URL.revokeObjectURL(url)
          reject(new Error('Failed to get canvas context'))
          return
        }

        ctx.drawImage(img, 0, 0)
        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(url)
          if (pngBlob) {
            resolve(pngBlob)
          } else {
            reject(new Error('Failed to convert image to png'))
          }
        }, 'image/png')
      } catch (error) {
        URL.revokeObjectURL(url)
        reject(error)
      }
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image for conversion'))
    }

    img.src = url
  })
}

/**
 * 任意来源（data:/file:/http(s)）的图像统一取为 Blob——V2 getImageBlobFromSource
 * 的 fork 移植（绘画骨架取色/自然尺寸解码共用）。data: 走 parseDataUrl + Base64
 * 解码；file:// 走 window.api.fs.read（ImageViewer 同款三分支）；http(s) 走 fetch。
 * 非 image/* MIME 视为未知类型（octet-stream），拒绝解码。
 */
export async function getImageBlobFromSource(src: string): Promise<Blob> {
  let blob: Blob

  if (src.startsWith('data:')) {
    const parseResult = parseDataUrl(src)
    if (!parseResult || !parseResult.mediaType || !parseResult.isBase64) {
      throw new Error('Invalid base64 image data URL')
    }
    const byteArray = Base64.toUint8Array(parseResult.data)
    blob = new Blob([byteArray.slice()], { type: parseResult.mediaType })
  } else if (src.startsWith('file://')) {
    const bytes = await window.api.fs.read(src)
    const mimeType = mime.getType(src) || 'application/octet-stream'
    blob = new Blob([bytes], { type: mimeType })
  } else {
    const response = await fetch(src)
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`)
    }
    blob = await response.blob()
  }

  return assertImageBlob(blob, src)
}

function assertImageBlob(blob: Blob, src: string): Blob {
  // `octet-stream` 是**误标**而不是"非图片"的判决：无扩展名的本地文件条目、以及不报 MIME 的
  // 远端都会落到这里，而字节本身仍能像 `<img>` 一样解码（V2 `assertImageBlob` 同款注释与判定）。
  // fork 缝：本条曾退化成"非 image/* 一律拒绝"，于是绘画文件（`file://` + 存储名
  // 无扩展名 ⇒ mime 查不到类型）**恒定失败**——自然尺寸取不到（实机日志 "Not an image blob:
  // application/octet-stream"）、骨架取色也静默降级。判定按 V2 恢复。
  const type = blob.type.trim()
  const unknown = type === 'application/octet-stream'
  if (type && !unknown && !type.startsWith('image/')) {
    throw new Error(`Source is not an image (content type ${type}): ${src}`)
  }
  return blob
}
