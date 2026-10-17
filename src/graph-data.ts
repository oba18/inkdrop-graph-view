import type { Note } from 'inkdrop-model'

import { getEnv } from './env'

const PAGE_SIZE = 500

/** `[label](inkdrop://note/ID)`, and the older `inkdrop://note:ID` form. */
const LINK_RE = /inkdrop:\/\/note[/:]([A-Za-z0-9_-]+)/g
const FENCE_RE = /^\s*(```|~~~)/

export interface NoteEntry {
  id: string
  title: string
  bookId: string
  tagIds: string[]
  status: Note['status']
  createdAt: number
  updatedAt: number
  /** Lower-cased body, for plain-text search */
  text: string
  /** Note ids this note links to (may include notes that no longer exist) */
  links: Set<string>
}

/** Note ids linked from a note body, skipping fenced code blocks. */
export function parseLinks(body: string): Set<string> {
  const out = new Set<string>()
  if (!body.includes('inkdrop://note')) return out
  let inFence = false
  for (const line of body.split('\n')) {
    if (FENCE_RE.test(line)) inFence = !inFence
    if (inFence) continue
    for (const m of line.matchAll(LINK_RE)) out.add(`note:${m[1]}`)
  }
  return out
}

let current: GraphIndex | null = null

/** The running index, or `null` before start / after stop. */
export function getIndex(): GraphIndex | null {
  return current
}

/**
 * In-memory index of every note (trash and templates excluded) with the links
 * between them, kept up to date from database changes.
 */
export class GraphIndex {
  notes = new Map<string, NoteEntry>()
  tags = new Map<string, string>()
  started = false
  /** Bumped on every change, so views can cheaply tell when to rebuild. */
  version = 0
  private listeners = new Set<() => void>()
  private subs: Array<{ dispose(): void }> = []
  private emitTimer: ReturnType<typeof setTimeout> | null = null

  async start() {
    current = this
    const env = getEnv()
    this.subs.push(
      env.localDB.onNoteChange(change => {
        this.handleChange(change).catch(err => console.error('[graph-view] change failed:', err))
      }),
      env.localDB.onTagChange(() => {
        this.loadTags().catch(err => console.error('[graph-view] tag load failed:', err))
      })
    )
    await this.loadTags()
    // `all()` leaves out completed / dropped notes; fetch those separately.
    // The result carries `docs` at runtime, despite the `rows` in @inkdropapp/types.
    for (let skip = 0; ; skip += PAGE_SIZE) {
      const res: any = await env.localDB.notes.all({
        limit: PAGE_SIZE,
        skip,
        pinnedFirst: false,
        sort: [{ createdAt: 'asc' }]
      })
      const docs: Note[] = res.docs ?? res.rows?.map((r: any) => r.doc).filter(Boolean) ?? []
      for (const doc of docs) this.index(doc)
      if (docs.length < PAGE_SIZE) break
    }
    for (const status of ['completed', 'dropped'] as const) {
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const res: any = await env.localDB.notes.findWithStatus(status, { limit: PAGE_SIZE, skip })
        const docs: Note[] = res.docs ?? []
        for (const doc of docs) this.index(doc)
        if (docs.length < PAGE_SIZE) break
      }
    }
    this.started = true
    this.emit()
    console.info(`[graph-view] indexed ${this.notes.size} notes`)
  }

  stop() {
    for (const s of this.subs) s.dispose()
    this.subs = []
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.notes.clear()
    this.listeners.clear()
    this.started = false
    if (current === this) current = null
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  private emit() {
    this.version++
    for (const l of this.listeners) l()
  }

  /** Coalesces bursts of changes (sync, bulk edits) into one update. */
  private emitSoon() {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit()
    }, 200)
  }

  private async loadTags() {
    const tags = await getEnv().localDB.tags.all()
    this.tags = new Map(tags.map(t => [t._id, t.name]))
    if (this.started) this.emitSoon()
  }

  private async handleChange(change: Record<string, any>) {
    const id: string | undefined = change.id ?? change.doc?._id ?? change._id
    if (!id?.startsWith('note:')) return
    if (change.deleted || change.doc?._deleted) {
      if (this.notes.delete(id)) this.emitSoon()
      return
    }
    const inline = change.doc ?? (change.body !== undefined ? change : undefined)
    const note: Note | undefined =
      inline?.body !== undefined
        ? inline
        : await getEnv()
            .localDB.notes.get(id)
            .catch(() => undefined)
    if (note) {
      if (!this.index(note)) return
    } else this.notes.delete(id)
    this.emitSoon()
  }

  /** Returns `false` when nothing the graph shows changed. */
  private index(note: Note): boolean {
    if (note.bookId === 'trash' || note.bookId === 'template') {
      return this.notes.delete(note._id)
    }
    const body = note.body ?? ''
    const prev = this.notes.get(note._id)
    const entry: NoteEntry = {
      id: note._id,
      title: note.title || '',
      bookId: note.bookId,
      tagIds: note.tags ?? [],
      status: note.status,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      text: body.toLowerCase(),
      links: parseLinks(body)
    }
    this.notes.set(note._id, entry)
    if (!prev) return true
    // Typing in a note changes its body on every save; only rebuild the graph
    // when something it draws changed. (A body-text search catches up on the
    // next rebuild.)
    return (
      prev.title !== entry.title ||
      prev.bookId !== entry.bookId ||
      prev.status !== entry.status ||
      prev.tagIds.join() !== entry.tagIds.join() ||
      prev.links.size !== entry.links.size ||
      [...entry.links].some(l => !prev.links.has(l))
    )
  }
}
