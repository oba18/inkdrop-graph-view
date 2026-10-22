import type { Environment, TelescopeContext, TelescopeResult, TelescopeSourceItem } from '@inkdropapp/types'
import { TelescopeSource } from 'inkdrop'

import { tr } from './i18n'

export interface JumpEntry {
  id: string
  icon: string
  en: string
  ja: string
  /** Extra words that also match */
  keywords?: string
  detail?: () => string
  /** Command dispatched on document.body when chosen */
  command: string
}

/**
 * Whether every typed word matches: English words at the start of a word
 * ("cal" → Calendar, not Local), Japanese anywhere (it has no spaces).
 */
export function matchesQuery(query: string, text: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = text.toLowerCase()
  const starts = hay.split(/[\s/()・]+/)
  return (
    words.length > 0 &&
    words.every(w => (/^[\x00-\x7f]+$/.test(w) ? starts.some(s => s.startsWith(w)) : hay.includes(w)))
  )
}

/** Inkdrop's own sources, which stay first. */
const CORE_SOURCES = ['commands', 'books', 'tags']

/**
 * ⌘K entries that open this plugin's views when you type their name, in
 * English or Japanese. Telescope's fuzzy filter doesn't match Japanese, so
 * matching is a plain substring test of every typed word.
 */
class JumpSource extends TelescopeSource {
  constructor(
    public id: string,
    public name: string,
    private describe: () => string,
    private entries: JumpEntry[],
    private env: Environment
  ) {
    super()
  }

  get description() {
    return this.describe()
  }

  getItems(context: TelescopeContext): TelescopeResult {
    const options: TelescopeSourceItem[] = this.entries
      .filter(e => matchesQuery(context.query, `${e.en} ${e.ja} ${e.keywords ?? ''}`))
      .map(e => ({
        id: e.id,
        source: this.id,
        type: this.name,
        label: `${e.en} ${e.ja} ${e.keywords ?? ''}`,
        displayLabel: `${e.icon} ${tr(e.en, e.ja)}`,
        detail: e.detail?.(),
        boost: 99,
        // Enter (core:submit) runs an item's action; without one it does nothing.
        actions: [{ type: 'open', label: tr('Open', '開く') }]
      }))
    return { options, filter: false }
  }

  apply(item: TelescopeSourceItem): boolean {
    const entry = this.entries.find(e => e.id === item.id)
    if (entry) this.env.commands.dispatch(document.body, entry.command as any)
    return true
  }
}

/**
 * Registers the entries ahead of other plugins' sources: Telescope lists
 * results by source registration order, and a note search would otherwise
 * bury them under every note that mentions the word.
 */
export function registerJumpSource(
  env: Environment,
  id: string,
  name: string,
  describe: () => string,
  entries: JumpEntry[]
): () => void {
  const { telescope } = env
  telescope.registerSource(new JumpSource(id, name, describe, entries, env))
  const later = [...telescope.availableSources.values()].filter(s => s.id !== id && !CORE_SOURCES.includes(s.id))
  for (const s of later) {
    telescope.unregisterSource(s.id)
    telescope.registerSource(s)
  }
  return () => {
    if (telescope.getSource(id)) telescope.unregisterSource(id)
  }
}
