import React, { useEffect, useMemo, useRef, useState } from 'react'

import { getEnv, onThemeChange, openNote } from './env'
import { getIndex } from './graph-data'
import { tr } from './i18n'
import {
  DEFAULT_SETTINGS,
  PALETTE,
  buildGraph,
  loadSettings,
  saveSettings,
  type GNode,
  type GraphKind,
  type GraphSettings,
  type QueryContext,
  type RegionBy
} from './graph-model'
import { GraphRenderer } from './renderer'

/** Re-renders whenever the note index changes (or finishes loading). */
function useIndexVersion(): number {
  const [version, setVersion] = useState(() => getIndex()?.version ?? 0)
  useEffect(() => {
    let sub: { dispose(): void } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const attach = () => {
      const index = getIndex()
      if (!index) {
        timer = setTimeout(attach, 300)
        return
      }
      sub = index.onDidChange(() => setVersion(index.version))
      setVersion(index.version)
    }
    attach()
    return () => {
      if (timer) clearTimeout(timer)
      sub?.dispose()
    }
  }, [])
  return version
}

function queryContext(): QueryContext {
  return {
    books: getEnv().store.getState().books?.hash ?? {},
    tags: getIndex()?.tags ?? new Map()
  }
}

interface Props {
  kind: GraphKind
  /** Local graph: the note at the center */
  center?: string | null
  /** Ringed node: the note open in the editor */
  focus?: string | null
  /** Called before a note is opened from the graph */
  onWillOpen?: () => void
  /** Extra buttons for the top-left toolbar */
  toolbar?: React.ReactNode
}

export const GraphPane: React.FC<Props> = ({ kind, center = null, focus = null, onWillOpen, toolbar }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<GraphRenderer | null>(null)
  const [settings, setSettings] = useState<GraphSettings>(() => loadSettings(kind))
  const [panelOpen, setPanelOpen] = useState(false)
  const [hover, setHover] = useState<GNode | null>(null)
  const version = useIndexVersion()
  const index = getIndex()

  const update = (patch: Partial<GraphSettings> | ((s: GraphSettings) => Partial<GraphSettings>)) =>
    setSettings(s => {
      const next = { ...s, ...(typeof patch === 'function' ? patch(s) : patch) }
      saveSettings(kind, next)
      return next
    })

  // Everything that changes which nodes / links exist.
  const graphKey = JSON.stringify([
    settings.search,
    settings.showTags,
    settings.showOrphans,
    settings.showClosed,
    settings.depth,
    settings.showIncoming,
    settings.showOutgoing,
    settings.neighborLinks,
    settings.groups
  ])
  const data = useMemo(
    () => (index?.started && (kind === 'global' || center) ? buildGraph(index, settings, queryContext(), center) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, version, graphKey, center, kind]
  )

  const onWillOpenRef = useRef(onWillOpen)
  onWillOpenRef.current = onWillOpen

  useEffect(() => {
    const canvas = canvasRef.current!
    const renderer = new GraphRenderer(canvas, {
      onOpen: (node, e) => {
        if (node.kind === 'tag') {
          // A tag node narrows the graph to that tag, like searching for it.
          update({ search: `tag:"${node.label.slice(1)}"` })
          return
        }
        if (kind === 'global' && e.shiftKey) return
        onWillOpenRef.current?.()
        openNote(node.id)
      },
      onHover: setHover
    })
    rendererRef.current = renderer
    // Theme switches restyle the app; pick the new colors up.
    const themeSub = onThemeChange(() => renderer.readColors())
    return () => {
      themeSub.dispose()
      renderer.dispose()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    rendererRef.current?.setSettings(settings)
  }, [settings])

  useEffect(() => {
    if (data) rendererRef.current?.setData(data)
  }, [data])

  useEffect(() => {
    rendererRef.current?.setFocus(focus)
  }, [focus])

  const hoverRegion = hover?.region ? data?.regions.find(r => r.id === hover.region) : undefined
  const counts = data ? tr(`${data.nodes.length} notes · ${data.links.length} links`, `${data.nodes.length} ノート · ${data.links.length} リンク`) : ''

  return (
    <div className={`graph-pane graph-pane-${kind}`}>
      <canvas ref={canvasRef} className="graph-canvas" />
      {!index?.started && <div className="graph-message">{tr('Loading notes…', 'ノートを読み込み中…')}</div>}
      {index?.started && kind === 'local' && !center && <div className="graph-message">{tr("Open a note to see its connections", 'ノートを開くと、そのノートのつながりを表示します')}</div>}
      {data && data.nodes.length === 0 && <div className="graph-message">{tr('No notes to show', '表示するノートがありません')}</div>}

      <div className="graph-toolbar">
        {toolbar}
        <span className="graph-counts">{counts}</span>
      </div>

      <div className="graph-zoom">
        <button type="button" title={tr('Zoom in', '拡大')} onClick={() => rendererRef.current?.zoomBy(1.3)}>
          ＋
        </button>
        <button type="button" title={tr('Zoom out', '縮小')} onClick={() => rendererRef.current?.zoomBy(1 / 1.3)}>
          −
        </button>
        <button type="button" title={tr('Fit to view', '全体を表示')} onClick={() => rendererRef.current?.fit()}>
          ⤢
        </button>
      </div>

      {hover && hover.kind === 'note' && (
        <div className="graph-hover-card">
          <div className="title">{hover.label}</div>
          <div className="meta">
            {hoverRegion && (
              <span className="region" style={{ color: hoverRegion.color }}>
                {hoverRegion.label} ·{' '}
              </span>
            )}
            {tr(`${hover.degree} links · click to open`, `リンク ${hover.degree} 件 · クリックで開く`)}
          </div>
        </div>
      )}

      <button
        type="button"
        className={`graph-settings-toggle${panelOpen ? ' active' : ''}`}
        title={tr('Graph settings', 'グラフの設定')}
        onClick={() => setPanelOpen(o => !o)}
      >
        <GearIcon />
      </button>
      {panelOpen && (
        <SettingsPanel
          kind={kind}
          settings={settings}
          update={update}
          onClose={() => setPanelOpen(false)}
          onAnimate={() => rendererRef.current?.animate()}
        />
      )}
    </div>
  )
}

GraphPane.displayName = 'GraphViewPane'

const GearIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

/* ---- the settings panel ---- */

interface PanelProps {
  kind: GraphKind
  settings: GraphSettings
  update: (patch: Partial<GraphSettings> | ((s: GraphSettings) => Partial<GraphSettings>)) => void
  onClose: () => void
  onAnimate: () => void
}

const Section: React.FC<{
  id: keyof GraphSettings['open']
  title: string
  settings: GraphSettings
  update: PanelProps['update']
  children: React.ReactNode
}> = ({ id, title, settings, update, children }) => {
  const open = settings.open[id]
  return (
    <section className={`graph-section${open ? ' open' : ''}`}>
      <h3 onClick={() => update(cur => ({ open: { ...cur.open, [id]: !cur.open[id] } }))}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        {title}
      </h3>
      {open && <div className="graph-section-body">{children}</div>}
    </section>
  )
}

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }> = ({
  label,
  checked,
  onChange,
  hint
}) => (
  <label className="graph-row graph-toggle" title={hint}>
    <span>{label}</span>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span className="switch" />
  </label>
)

const Slider: React.FC<{
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}> = ({ label, value, min, max, step, onChange }) => (
  <label className="graph-row graph-slider">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
  </label>
)

const REGION_CHOICES: Array<{ value: RegionBy; label: string }> = [
  { value: 'tag', label: tr('Tag', 'タグ') },
  { value: 'book', label: tr('Notebook', 'ノートブック') },
  { value: 'none', label: tr('None', 'なし') }
]

const SettingsPanel: React.FC<PanelProps> = ({ kind, settings, update, onClose, onAnimate }) => {
  const s = settings

  const colorByNotebook = () => {
    const books = Object.values(getEnv().store.getState().books?.hash ?? {}) as Array<{ name: string; parentBookId?: string | null }>
    const roots = books.filter(b => !b.parentBookId).sort((a, b) => a.name.localeCompare(b.name))
    update({
      groups: roots.map((b, i) => ({ query: `book:"${b.name}"`, color: PALETTE[i % PALETTE.length] })),
      open: { ...s.open, groups: true }
    })
  }

  return (
    <div className="graph-settings" onKeyDown={e => e.stopPropagation()}>
      <div className="graph-settings-header">
        <button
          type="button"
          title={tr('Reset to defaults', '既定の設定に戻す')}
          onClick={() => update({ ...DEFAULT_SETTINGS, open: s.open })}
        >
          ↺
        </button>
        <button type="button" title={tr('Close', '閉じる')} onClick={onClose}>
          ✕
        </button>
      </div>

      <Section id="filters" title={tr('Filters', 'フィルター')} settings={s} update={update}>
        <input
          type="search"
          className="graph-search"
          placeholder={tr('Search notes…  tag:x  book:x  -status:dropped', 'ノートを検索…  tag:x  book:x  -status:dropped')}
          value={s.search}
          onChange={e => update({ search: e.target.value })}
        />
        {kind === 'local' && (
          <>
            <Slider label={tr(`Depth (${s.depth})`, `深さ（${s.depth}）`)} value={s.depth} min={1} max={5} step={1} onChange={v => update({ depth: v })} />
            <Toggle label={tr('Incoming links (backlinks)', 'リンク元（被リンク）')} checked={s.showIncoming} onChange={v => update({ showIncoming: v })} />
            <Toggle label={tr('Outgoing links', 'リンク先')} checked={s.showOutgoing} onChange={v => update({ showOutgoing: v })} />
            <Toggle
              label={tr('Neighbor links', '近傍のリンク')}
              hint={tr('Also show links between the connected notes', 'つながったノート同士のリンクも表示')}
              checked={s.neighborLinks}
              onChange={v => update({ neighborLinks: v })}
            />
          </>
        )}
        <Toggle label={tr('Tags', 'タグ')} checked={s.showTags} onChange={v => update({ showTags: v })} />
        <Toggle label={tr('Orphans', '孤立したノート')} hint={tr('Notes with no links', 'どことも繋がっていないノート')} checked={s.showOrphans} onChange={v => update({ showOrphans: v })} />
        <Toggle
          label={tr('Completed / dropped notes', '完了・中止のノート')}
          hint={tr('Notes whose status is Completed or Dropped', 'ステータスが Completed / Dropped のノート')}
          checked={s.showClosed}
          onChange={v => update({ showClosed: v })}
        />
      </Section>

      <Section id="regions" title={tr('Regions', '領域')} settings={s} update={update}>
        <div className="graph-row graph-choice">
          <span>{tr('Group by', 'まとめ方')}</span>
          <div className="graph-segment">
            {REGION_CHOICES.map(c => (
              <button
                key={c.value}
                type="button"
                className={s.regionBy === c.value ? 'active' : ''}
                onClick={() => update({ regionBy: c.value })}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {s.regionBy !== 'none' && (
          <>
            <Toggle label={tr('Show regions', '領域を表示')} hint={tr('Draws the region backgrounds and names', '領域の背景と名前を描きます')} checked={s.showRegions} onChange={v => update({ showRegions: v })} />
            <Slider label={tr('Clustering strength', 'まとまりの強さ')} value={s.regionForce} min={0} max={1} step={0.01} onChange={v => update({ regionForce: v })} />
            <Slider
              label={tr(`Number of regions (max ${s.maxRegions})`, `領域の数（最大 ${s.maxRegions}）`)}
              value={s.maxRegions}
              min={2}
              max={30}
              step={1}
              onChange={v => update({ maxRegions: v })}
            />
            <p className="graph-hint">
              {s.regionBy === 'tag'
                ? tr('Each note goes into the region of its most used tag. ', 'ノートの中で一番多く使われているタグの領域に入ります。')
                : tr('Each top-level notebook gets its own region. ', '最上位のノートブックごとの領域に入ります。')}
              {tr('Regions with few notes gather in the center as "Others".', 'ノートが少ない領域は「その他」として中央に集まります。')}
            </p>
          </>
        )}
      </Section>

      <Section id="groups" title={tr('Groups', 'グループ')} settings={s} update={update}>
        {s.groups.map((g, i) => (
          <div key={i} className="graph-group">
            <input
              type="text"
              placeholder={tr('tag:x / book:x / keyword', 'tag:x / book:x / キーワード')}
              value={g.query}
              onChange={e => update({ groups: s.groups.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)) })}
            />
            <input
              type="color"
              value={g.color}
              onChange={e => update({ groups: s.groups.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })}
            />
            <button type="button" title={tr('Delete', '削除')} onClick={() => update({ groups: s.groups.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        ))}
        <div className="graph-buttons">
          <button
            type="button"
            className="primary"
            onClick={() => update({ groups: [...s.groups, { query: '', color: PALETTE[s.groups.length % PALETTE.length] }] })}
          >
            {tr('New group', '新しいグループ')}
          </button>
          <button type="button" onClick={colorByNotebook} title={tr('Recreates the groups, one per top-level notebook', '最上位のノートブックごとにグループを作り直します')}>
            {tr('Color by notebook', 'ノートブックで色分け')}
          </button>
        </div>
      </Section>

      <Section id="display" title={tr('Display', '表示')} settings={s} update={update}>
        <Toggle label={tr('Arrows', '矢印')} checked={s.arrows} onChange={v => update({ arrows: v })} />
        <Slider label={tr('Text fade threshold', '文字のフェード')} value={s.textFade} min={-3} max={3} step={0.1} onChange={v => update({ textFade: v })} />
        <Slider label={tr('Node size', 'ノードの大きさ')} value={s.nodeSize} min={0.1} max={5} step={0.05} onChange={v => update({ nodeSize: v })} />
        <Slider label={tr('Link thickness', 'リンクの太さ')} value={s.linkThickness} min={0.1} max={5} step={0.05} onChange={v => update({ linkThickness: v })} />
        <div className="graph-buttons">
          <button type="button" className="primary" onClick={onAnimate} title={tr('Shows the notes one by one in the order they were created', 'ノートを作成順に表示していきます')}>
            {tr('Animate', 'アニメーション')}
          </button>
        </div>
      </Section>

      <Section id="forces" title={tr('Forces', 'フォース')} settings={s} update={update}>
        <Slider label={tr('Center force', '中心力')} value={s.centerForce} min={0} max={1} step={0.01} onChange={v => update({ centerForce: v })} />
        <Slider label={tr('Repel force', '反発力')} value={s.repelForce} min={0} max={20} step={0.1} onChange={v => update({ repelForce: v })} />
        <Slider label={tr('Link force', 'リンクの力')} value={s.linkForce} min={0} max={1} step={0.01} onChange={v => update({ linkForce: v })} />
        <Slider label={tr('Link distance', 'リンクの距離')} value={s.linkDistance} min={30} max={500} step={1} onChange={v => update({ linkDistance: v })} />
      </Section>
    </div>
  )
}
