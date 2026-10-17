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
