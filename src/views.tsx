import React, { useEffect, useRef, useState } from 'react'

import { getEnv, peekEnv } from './env'
import { tr, useLanguage } from './i18n'
import { GraphPane } from './graph-pane'
import { announcePageView, onOtherPageView } from './page-view'

/* ---- small observable flags ---- */

function flag(initial: boolean, onChange?: (v: boolean) => void) {
  let value = initial
  const listeners = new Set<(v: boolean) => void>()
  return {
    get: () => value,
    set(next: boolean) {
      if (value === next) return
      value = next
      onChange?.(next)
      for (const l of listeners) l(next)
    },
    use(): boolean {
      const [v, setV] = useState(value)
      useEffect(() => {
        listeners.add(setV)
        setV(value)
        return () => {
          listeners.delete(setV)
        }
      }, [])
      return v
    }
  }
}

const GLOBAL_CLASS = 'graph-view-active'
const LOCAL_KEY = 'inkdrop-graph-view:local-open'
const LOCAL_WIDTH_KEY = 'inkdrop-graph-view:local-width'

/** Whether the global graph is showing, in place of the note list and editor. */
export const globalGraph = flag(false, v => {
  document.body.classList.toggle(GLOBAL_CLASS, v)
  if (v) announcePageView(PAGE_VIEW_ID)
})

const PAGE_VIEW_ID = 'graph-view'

/** Closes the global graph when another full-page view (Tasks, Habits…) opens. */
export function closeOnOtherPageView(): () => void {
  return onOtherPageView(PAGE_VIEW_ID, () => globalGraph.set(false))
}

function loadBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** Whether the local graph pane is open beside the editor. */
export const localGraph = flag(loadBool(LOCAL_KEY), v => {
  try {
    localStorage.setItem(LOCAL_KEY, v ? '1' : '0')
  } catch {
    // Not remembered.
  }
})

/** The id of the note open in the editor. */
function useEditingNoteId(): string | null {
  const read = () => (peekEnv()?.store.getState().editingNote?._id as string | undefined) ?? null
  const [id, setId] = useState(read)
  useEffect(() => {
    const unsubscribe = getEnv().store.subscribe(() => setId(read()))
    return () => unsubscribe()
  }, [])
  return id
}

/* ---- sidebar item ---- */

const GraphIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" className="svg-icon graph-view-icon">
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="6" cy="6" r="2.25" />
      <circle cx="18" cy="8" r="2.25" />
      <circle cx="9" cy="18" r="2.25" />
      <circle cx="19" cy="19" r="1.5" />
      <path d="M8 7l7.9.7M7 8l1.6 7.8M10.9 16.9l6.4-7M11.2 18.3l6.3.6" />
    </g>
  </svg>
)

/** "Graph" entry under All Notes / Templates in the sidebar. */
export const SideBarMenuItemGraph: React.FC = () => {
  const active = globalGraph.use()
  // Can still render once while the plugin is being deactivated.
  const env = peekEnv()
  if (!env) return null
  const { SideBarMenuItem } = env.components.classes as Record<string, React.ComponentType<any>>
  if (!SideBarMenuItem) return null
  return (
    <SideBarMenuItem
      className="sidebar-menu-item-graph"
      selectable
      active={active}
      onClick={() => env.commands.dispatch(document.body, 'graph-view:show' as any)}
      renderIcon={() => <GraphIcon />}
    >
      Graph
    </SideBarMenuItem>
  )
}

SideBarMenuItemGraph.displayName = 'GraphViewSideBarMenuItem'

/* ---- the global graph ---- */

export const GlobalGraphView: React.FC = () => {
  useLanguage()
  const active = globalGraph.use()
  if (!active || !peekEnv()) return null
  return <GlobalGraphBody />
}

GlobalGraphView.displayName = 'GraphViewGlobal'

const GlobalGraphBody: React.FC = () => {
  const env = getEnv()
  const editingId = useEditingNoteId()

  useEffect(() => {
    // Leave the graph when another sidebar item is picked or a note is opened
    // some other way.
    const onClick = (e: MouseEvent) => {
      const item = (e.target as Element).closest?.('.sidebar-layout .sidebar-menu-item')
      if (item && !item.classList.contains('sidebar-menu-item-graph')) globalGraph.set(false)
    }
    document.addEventListener('click', onClick, true)
    let { queryContext, editingNote } = env.store.getState()
    let noteId = editingNote?._id
    const unsubscribe = env.store.subscribe(() => {
      const state = env.store.getState()
      if (state.queryContext !== queryContext || state.editingNote?._id !== noteId) globalGraph.set(false)
      queryContext = state.queryContext
      noteId = state.editingNote?._id
    })
    return () => {
      document.removeEventListener('click', onClick, true)
      unsubscribe()
    }
  }, [])

  return (
    <div className="graph-view-global">
      <GraphPane
        kind="global"
        focus={editingId}
        onWillOpen={() => globalGraph.set(false)}
        toolbar={<span className="graph-title">Graph</span>}
      />
    </div>
  )
}

/* ---- the local graph pane ---- */

const MIN_WIDTH = 220
const DEFAULT_WIDTH = 360

function loadWidth(): number {
  try {
    const w = Number(localStorage.getItem(LOCAL_WIDTH_KEY))
    return w >= MIN_WIDTH ? w : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

export const LocalGraphView: React.FC = () => {
  useLanguage()
  const open = localGraph.use()
  if (!open || !peekEnv()) return null
  return <LocalGraphBody />
}

LocalGraphView.displayName = 'GraphViewLocal'

const LocalGraphBody: React.FC = () => {
  const noteId = useEditingNoteId()
  const [width, setWidth] = useState(loadWidth)
  const dragRef = useRef<{ x: number; w: number } | null>(null)

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, w: width }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const max = Math.max(MIN_WIDTH, window.innerWidth * 0.7)
    setWidth(Math.min(max, Math.max(MIN_WIDTH, dragRef.current.w - (e.clientX - dragRef.current.x))))
  }
  const onResizeEnd = () => {
    if (!dragRef.current) return
    dragRef.current = null
    try {
      localStorage.setItem(LOCAL_WIDTH_KEY, String(width))
    } catch {
      // Not remembered.
    }
  }

  return (
    <div className="graph-view-local" style={{ width }}>
      <div
        className="graph-resize-handle"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
      />
      <GraphPane
        kind="local"
        center={noteId}
        focus={noteId}
        toolbar={
          <>
            <span className="graph-title">{tr('Local graph', 'ローカルグラフ')}</span>
            <button type="button" className="graph-close" title={tr('Close', '閉じる')} onClick={() => localGraph.set(false)}>
              ✕
            </button>
          </>
        }
      />
    </div>
  )
}

/* ---- editor header button ---- */

/** Toggles the local graph pane for the open note. */
export const LocalGraphButton: React.FC = () => {
  useLanguage()
  const open = localGraph.use()
  const env = peekEnv()
  if (!env) return null
  const { AppHeaderButton } = env.components.classes as Record<string, React.ComponentType<any>>
  if (!AppHeaderButton) return null
  return (
    <AppHeaderButton
      className={`icon graph-view-local-button${open ? ' active' : ''}`}
      title={open ? tr('Close local graph', 'ローカルグラフを閉じる') : tr("Show this note's local graph", 'このノートのローカルグラフを表示')}
      onClick={() => env.commands.dispatch(document.body, 'graph-view:toggle-local' as any)}
    >
      <GraphIcon />
    </AppHeaderButton>
  )
}

LocalGraphButton.displayName = 'GraphViewLocalButton'
