import type { Environment } from '@inkdropapp/types'

import { tr } from './i18n'

/** Registers the Plugins menu and the editor "more" menu entries in the UI language. */
export function addMenus(env: Environment): { dispose(): void } {
  const toggleLocal = tr('Toggle Local Graph', 'ローカルグラフの表示を切り替え')
  const menu = env.menu.add([
    {
      label: 'Plugins',
      submenu: [
        {
          label: 'Graph View',
          submenu: [
            { label: tr('Show Graph View', 'グラフビューを表示'), command: 'graph-view:show' },
            { label: toggleLocal, command: 'graph-view:toggle-local' }
          ]
        }
      ]
    }
  ] as any)
  const context = env.contextMenu.add({
    '.editor-header-more .menu': [{ label: toggleLocal, command: 'graph-view:toggle-local' }]
  } as any)
  return {
    dispose() {
      menu.dispose()
      context.dispose()
    }
  }
}
