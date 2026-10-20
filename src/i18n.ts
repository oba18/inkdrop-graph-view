import type { ConfigSchema } from '@inkdropapp/types'
import { useEffect, useState } from 'react'

import { peekEnv } from './env'

export type Lang = 'en' | 'ja'

const PACKAGE = 'graph-view'

/**
 * Inkdrop always reports `en-US` as the UI language, but `navigator.languages`
 * also lists the system's preferred languages, so Japanese systems include `ja`.
 */
function systemLang(): Lang {
  return navigator.languages.some(l => /^ja\b/i.test(l)) ? 'ja' : 'en'
}

/** The plugin's UI language: the `language` setting, or the system's when `auto`. */
export function lang(): Lang {
  const setting = peekEnv()?.config.get(`${PACKAGE}.language`)
  return setting === 'en' || setting === 'ja' ? setting : systemLang()
}

/** Re-renders the calling component when the Language setting changes. */
export function useLanguage(): Lang {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const sub = peekEnv()?.config.onDidChange(`${PACKAGE}.language`, () => setVersion(v => v + 1))
    return () => sub?.dispose()
  }, [])
  return lang()
}

/** The English or Japanese text, for the current language. */
export function tr(en: string, ja: string): string {
  return lang() === 'ja' ? ja : en
}

export const languageConfig: ConfigSchema = {
  title: 'Language',
  description: 'Language of the plugin UI. "auto" uses Japanese if it is one of your system languages, otherwise English.',
  type: 'string',
  default: 'auto',
  enum: ['auto', 'en', 'ja']
}
