/**
 * Full-page views from these plugins (reminder's Tasks, habits' Habits page,
 * graph-view's graph) all take the place of the note list and editor, so only
 * one may show. Whichever opens announces itself; the others close. Plain DOM
 * events, so the plugins don't depend on each other.
 */
const EVENT = 'inkdrop-page-view-open'

export function announcePageView(id: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id } }))
}

/** Calls `close` when another page view opens; returns the unsubscribe. */
export function onOtherPageView(id: string, close: () => void): () => void {
  const handler = (e: Event) => {
    if ((e as CustomEvent<{ id: string }>).detail?.id !== id) close()
  }
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

/**
 * Calls `close` whenever a note is opened (`core:open-note`, from ⌘K, links,
 * a task row, a graph node…), even when it is the note already behind the
 * view, so the editor shows. Commands are DOM events: a window capture
 * listener sees every dispatch.
 */
export function closeOnOpenNote(close: () => void): () => void {
  window.addEventListener('core:open-note', close, true)
  return () => window.removeEventListener('core:open-note', close, true)
}
