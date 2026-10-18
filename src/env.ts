import type { Environment } from '@inkdropapp/types'

/**
 * Captures the `Environment` handed to `activate()` so other modules can reach
 * it without the (discouraged) global `inkdrop`.
 */
let captured: Environment | undefined

export function setEnv(env: Environment | undefined): void {
  captured = env
}

/** The env, or `undefined` once the plugin is deactivated. */
export function peekEnv(): Environment | undefined {
  return captured
}

export function getEnv(): Environment {
  if (!captured) throw new Error('[graph-view] env accessed before activate()')
  return captured
}

/** Opens a note in the editor and brings the window forward. */
export function openNote(noteId: string): void {
  const env = getEnv()
  env.window.show()
  env.window.focus()
  env.commands.dispatch(document.body, 'core:open-note', { noteId, selectInNoteListBar: true })
}

/**
 * Calls `cb` whenever the app's colors may have changed: a theme switch (its
 * stylesheets can land a moment after the event), a light/dark class change
 * on `<body>`, or the OS appearance flipping.
 */
export function onThemeChange(cb: () => void): { dispose(): void } {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const fire = () => {
    for (const delay of [0, 150, 600]) {
      const t = setTimeout(() => {
        timers.delete(t)
        cb()
      }, delay)
      timers.add(t)
    }
  }
  const themeSub = getEnv().themes.onDidChangeActiveThemes?.(fire)
  const observer = new MutationObserver(fire)
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', fire)
  return {
    dispose() {
      themeSub?.dispose()
      observer.disconnect()
      media.removeEventListener('change', fire)
      for (const t of timers) clearTimeout(t)
    }
  }
}
