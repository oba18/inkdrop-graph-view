import type { GraphIndex, NoteEntry } from './graph-data'

/* ---- settings (the Obsidian graph panel: Filters / Groups / Display / Forces) ---- */

export interface Group {
  query: string
  color: string
}

export type RegionBy = 'none' | 'tag' | 'book'

export interface GraphSettings {
  // Filters
  search: string
  showTags: boolean
  showOrphans: boolean
  showClosed: boolean
  // Local graph only
  depth: number
  showIncoming: boolean
  showOutgoing: boolean
  neighborLinks: boolean
  // Groups
  groups: Group[]
  // Regions: notes gathered into areas by tag or notebook
  regionBy: RegionBy
  showRegions: boolean
  /** 0 … 1: how tightly a region's notes keep together */
  regionForce: number
  maxRegions: number
  // Display
  arrows: boolean
  /** -3 (labels show early) … 3 (only when zoomed far in) */
  textFade: number
  nodeSize: number
  linkThickness: number
  // Forces
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
  // Which panel sections are open
  open: Record<'filters' | 'regions' | 'groups' | 'display' | 'forces', boolean>
}

export const DEFAULT_SETTINGS: GraphSettings = {
  search: '',
  showTags: false,
  showOrphans: true,
  showClosed: true,
  depth: 1,
  showIncoming: true,
  showOutgoing: true,
  neighborLinks: true,
  groups: [],
  regionBy: 'tag',
  showRegions: true,
  regionForce: 0.5,
  maxRegions: 12,
  arrows: false,
  textFade: 0,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.5,
  repelForce: 10,
  linkForce: 1,
  linkDistance: 250,
  open: { filters: true, regions: false, groups: false, display: false, forces: false }
}

export type GraphKind = 'global' | 'local'

const storageKey = (kind: GraphKind) => `inkdrop-graph-view:settings:${kind}`

export function loadSettings(kind: GraphKind): GraphSettings {
  // A local graph is small: show its labels without zooming in.
  const base = kind === 'local' ? { ...DEFAULT_SETTINGS, textFade: -1.5 } : DEFAULT_SETTINGS
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(kind)) ?? '{}')
    return { ...base, ...saved, open: { ...base.open, ...saved.open } }
  } catch {
    return { ...base }
  }
}

export function saveSettings(kind: GraphKind, s: GraphSettings) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(s))
  } catch {
    // Not remembered; defaults next time.
  }
}

/** Distinct, mid-saturation colors that read on light and dark themes. */
export const PALETTE = [
  '#e5534b',
  '#e0823d',
  '#c69026',
  '#57ab5a',
  '#39c5bb',
  '#539bf5',
  '#986ee2',
  '#e275ad',
  '#8ddb8c',
  '#f69d50'
]

/* ---- search queries ---- */

export interface QueryContext {
  books: Record<string, { name: string; parentBookId?: string | null }>
  tags: Map<string, string>
}

type Term = { neg: boolean; key: string | null; value: string }

/** `foo "bar baz" tag:x book:"My Book" -status:dropped` → terms (all must match). */
function parseQuery(q: string): Term[] {
  const terms: Term[] = []
  const re = /(-)?(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g
  for (const m of q.matchAll(re)) {
    const value = (m[3] ?? m[4] ?? '').toLowerCase()
    if (!value) continue
    terms.push({ neg: !!m[1], key: m[2]?.toLowerCase() ?? null, value })
  }
  return terms
}

/** The note's notebook and every notebook above it. */
function bookNames(bookId: string, ctx: QueryContext): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (let id: string | null | undefined = bookId; id && !seen.has(id); id = ctx.books[id]?.parentBookId) {
    seen.add(id)
    if (ctx.books[id]) names.push(ctx.books[id].name.toLowerCase())
  }
  return names
}

function termMatches(note: NoteEntry, t: Term, ctx: QueryContext): boolean {
  switch (t.key) {
    case 'tag':
      return note.tagIds.some(id => (ctx.tags.get(id) ?? '').toLowerCase() === t.value)
    case 'book':
    case 'notebook':
      return bookNames(note.bookId, ctx).some(n => n.includes(t.value))
    case 'status':
      return (note.status ?? 'none').toLowerCase() === t.value
    case 'title':
      return note.title.toLowerCase().includes(t.value)
    case 'body':
      return note.text.includes(t.value)
    default:
      return note.title.toLowerCase().includes(t.value) || note.text.includes(t.value)
  }
}

/** Compiles a query into a note predicate; an empty query matches everything. */
export function compileQuery(q: string, ctx: QueryContext): ((note: NoteEntry) => boolean) | null {
  const terms = parseQuery(q)
  if (!terms.length) return null
  return note => terms.every(t => termMatches(note, t, ctx) !== t.neg)
}

/* ---- building the graph ---- */

export interface GNode {
  id: string
  kind: 'note' | 'tag'
  label: string
  /** Group (or region) color, or `null` for the default node color */
  color: string | null
  /** Id of the region the node sits in */
  region: string | null
  /** Number of links, for the node size */
  degree: number
  createdAt: number
  /** Local graph: hops from the center */
  depth?: number
  // d3-force fields
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
  index?: number
}

export interface GLink {
  source: string | GNode
  target: string | GNode
}

/** An area of the graph: the notes sharing a tag or a top-level notebook. */
export interface Region {
  id: string
  label: string
  color: string
  size: number
}

export interface GraphData {
  nodes: GNode[]
  links: GLink[]
  regions: Region[]
}

const CLOSED = new Set(['completed', 'dropped'])

/**
 * Nodes and links for the current settings. For the local graph, `center` is
 * the note at the middle; the result holds the notes within `depth` hops.
 */
export function buildGraph(
  index: GraphIndex,
  settings: GraphSettings,
  ctx: QueryContext,
  center: string | null = null
): GraphData {
  const match = compileQuery(settings.search, ctx)
  const groups = settings.groups
    .map(g => ({ color: g.color, test: compileQuery(g.query, ctx) }))
    .filter((g): g is { color: string; test: (n: NoteEntry) => boolean } => !!g.test)

  // Note → note edges (deduped, both directions kept apart for local filtering).
  const included = new Set<string>()
  for (const note of index.notes.values()) {
    if (!settings.showClosed && CLOSED.has(note.status ?? '') && note.id !== center) continue
    if (match && !match(note) && note.id !== center) continue
    included.add(note.id)
  }

  type Edge = { s: string; t: string }
  const edges: Edge[] = []
  const edgeKeys = new Set<string>()
  const addEdge = (s: string, t: string) => {
    const key = `${s}\u0000${t}`
    if (s === t || edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ s, t })
  }
  for (const id of included) {
    const note = index.notes.get(id)!
    for (const target of note.links) if (included.has(target)) addEdge(id, target)
    if (settings.showTags) for (const tagId of note.tagIds) if (index.tags.has(tagId)) addEdge(id, tagId)
  }

  let keep: Map<string, number> | null = null
  if (center) {
    // Breadth-first out from the center, following the allowed directions.
    const out = new Map<string, string[]>()
    const inc = new Map<string, string[]>()
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const list = m.get(k)
      if (list) list.push(v)
      else m.set(k, [v])
    }
    for (const e of edges) {
      push(out, e.s, e.t)
      push(inc, e.t, e.s)
    }
    keep = new Map([[center, 0]])
    let frontier = [center]
    for (let d = 1; d <= settings.depth && frontier.length; d++) {
      const next: string[] = []
      for (const id of frontier) {
        const around = [
          ...(settings.showOutgoing ? (out.get(id) ?? []) : []),
          ...(settings.showIncoming ? (inc.get(id) ?? []) : []),
          // Tags are hubs, not links between notes: always walk through them both ways.
          ...(id.startsWith('tag:') ? [...(out.get(id) ?? []), ...(inc.get(id) ?? [])] : [])
        ]
        for (const n of around) {
          if (keep.has(n)) continue
          keep.set(n, d)
          next.push(n)
        }
      }
      frontier = next
    }
  }

  const nodeIds = new Set<string>(keep ? keep.keys() : included)
  if (!keep && settings.showTags) for (const e of edges) if (e.t.startsWith('tag:')) nodeIds.add(e.t)

  const links = edges.filter(e => {
    if (!nodeIds.has(e.s) || !nodeIds.has(e.t)) return false
    // Without neighbor links, the local graph keeps only the links that lead
    // outward from the center (between different hop counts).
    return !keep || settings.neighborLinks || keep.get(e.s) !== keep.get(e.t)
  })

  const degree = new Map<string, number>()
  for (const e of links) {
    degree.set(e.s, (degree.get(e.s) ?? 0) + 1)
    degree.set(e.t, (degree.get(e.t) ?? 0) + 1)
  }

  const nodes: GNode[] = []
  for (const id of nodeIds) {
    const deg = degree.get(id) ?? 0
    if (!settings.showOrphans && deg === 0 && id !== center) continue
    if (id.startsWith('tag:')) {
      nodes.push({ id, kind: 'tag', label: `#${index.tags.get(id) ?? ''}`, color: null, region: null, degree: deg, createdAt: 0, depth: keep?.get(id) })
      continue
    }
    const note = index.notes.get(id)
    if (!note) continue
    const group = groups.find(g => g.test(note))
    nodes.push({
      id,
      kind: 'note',
      label: note.title || '無題のノート',
      color: group?.color ?? null,
      region: null,
      degree: deg,
      createdAt: note.createdAt,
      depth: keep?.get(id)
    })
  }
  const regions = assignRegions(nodes, index, settings, ctx)
  const shown = new Set(nodes.map(n => n.id))
  return {
    nodes,
    links: links.filter(e => shown.has(e.s) && shown.has(e.t)).map(e => ({ source: e.s, target: e.t })),
    regions
  }
}

/** The notebook at the top of `bookId`'s tree. */
function rootBook(bookId: string, ctx: QueryContext): string | null {
  const seen = new Set<string>()
  let id: string | null | undefined = bookId
  while (id && ctx.books[id]?.parentBookId && !seen.has(id)) {
    seen.add(id)
    id = ctx.books[id].parentBookId
  }
  return id && ctx.books[id] ? id : null
}

/**
 * Puts each note in a region: by tag, the note's most widely used tag; by
 * notebook, its top-level notebook. Only the largest `maxRegions` regions (of
 * two notes or more) are kept; the rest of the notes float between them.
 * Notes without a group color take their region's color.
 */
function assignRegions(nodes: GNode[], index: GraphIndex, settings: GraphSettings, ctx: QueryContext): Region[] {
  if (settings.regionBy === 'none') return []
  const notes = nodes.filter(n => n.kind === 'note')
  const candidates = new Map<GNode, string[]>()
  for (const n of notes) {
    const note = index.notes.get(n.id)!
    if (settings.regionBy === 'tag') candidates.set(n, note.tagIds.filter(id => ctx.tags.has(id)))
    else {
      const root = rootBook(note.bookId, ctx)
      candidates.set(n, root ? [root] : [])
    }
  }
  const count = new Map<string, number>()
  for (const ids of candidates.values()) for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1)
  const label = (id: string) =>
    settings.regionBy === 'tag' ? `#${ctx.tags.get(id) ?? ''}` : (ctx.books[id]?.name ?? '')
  const pick = (ids: string[]) =>
    ids.reduce<string | null>(
      (best, id) =>
        !best || count.get(id)! > count.get(best)! || (count.get(id) === count.get(best) && label(id) < label(best))
          ? id
          : best,
      null
    )
  const chosen = new Map<GNode, string>()
  const size = new Map<string, number>()
  for (const [n, ids] of candidates) {
    const id = pick(ids)
    if (!id) continue
    chosen.set(n, id)
    size.set(id, (size.get(id) ?? 0) + 1)
  }
  const kept = [...size]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0])))
    .slice(0, Math.max(1, settings.maxRegions))
  const regions: Region[] = kept.map(([id, n], i) => ({
    id,
    label: label(id),
    color: PALETTE[i % PALETTE.length],
    size: n
  }))
  const byId = new Map(regions.map(r => [r.id, r]))
  for (const [n, id] of chosen) {
    const r = byId.get(id)
    if (!r) continue
    n.region = id
    n.color ??= r.color
  }
  // A tag shown as a node sits in its own region.
  for (const n of nodes) {
    if (n.kind !== 'tag') continue
    const r = byId.get(n.id)
    if (r) n.region = r.id
  }
  return regions
}
