import 'dayjs/locale/zh-cn'

import { loggerService } from '@logger'
import { defaultLanguage } from '@shared/config/constant'
import dayjs from 'dayjs'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Original translation（机翻语言包已整体移除，只保留 zh-CN / en-US）
// en-US 是 defaultLanguage/fallbackLng，必须静态在场；zh-CN 按需装载（问题5 #4：
// i18n chunk 418KB 曾双语言全量内联，非活动语言包改为动态 chunk）。
import enUS from './locales/en-us.json'

const logger = loggerService.withContext('I18N')

let zhBundleData: typeof enUS | null = null

const loadZhBundle = async (): Promise<typeof enUS> => {
  if (!zhBundleData) {
    zhBundleData = (await import('./locales/zh-cn.json')).default as typeof enUS
  }
  return zhBundleData
}

export const getLanguage = () => {
  return localStorage.getItem('language') || navigator.language || defaultLanguage
}

export const getLanguageCode = () => {
  return getLanguage().split('-')[0]
}

// Map i18n language codes to dayjs locale codes
const dayjsLocaleMap: Record<string, string> = {
  'en-US': 'en',
  'zh-CN': 'zh-cn'
}

export const setDayjsLocale = (language: string) => {
  const dayjsLocale = dayjsLocaleMap[language] || 'en'
  dayjs.locale(dayjsLocale)
}

let initPromise: Promise<void> | null = null

/**
 * Initialize i18n with the boot language. The three window entries gate the first
 * render on this promise, so the active bundle is complete before any t() call.
 * en-US rides the static graph; a zh boot language pays one local chunk fetch.
 */
export async function initI18n(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const lng = getLanguage()
    const resources: Record<string, { translation: typeof enUS }> = { 'en-US': { translation: enUS } }
    if (lng.startsWith('zh')) {
      resources['zh-CN'] = { translation: await loadZhBundle() }
    }
    await i18n.use(initReactI18next).init({
      resources,
      lng,
      fallbackLng: defaultLanguage,
      interpolation: {
        escapeValue: false
      },
      saveMissing: true,
      missingKeyHandler: (_1, _2, key) => {
        logger.error(`Missing key: ${key}`)
      }
    })
  })()
  return initPromise
}

/**
 * Runtime language switch. Loads the target bundle before changeLanguage so the
 * new language never renders from missing resources. Same contract as
 * i18n.changeLanguage for the four call sites (main settings, useAppInit,
 * mini HomeWindow, trace window).
 */
export async function changeAppLanguage(lng: string): Promise<void> {
  if (lng.startsWith('zh')) {
    try {
      const data = await loadZhBundle()
      if (i18n.isInitialized) {
        i18n.addResourceBundle('zh-CN', 'translation', data, true, true)
      }
    } catch (error) {
      logger.error('Failed to load zh-CN locale bundle', error as Error)
    }
  }
  await i18n.changeLanguage(lng)
}

export default i18n
