import type { Environment, IInkdropPlugin } from '@inkdropapp/types'

import { setEnv } from './env'
import { languageConfig, tr } from './i18n'
import { addMenus } from './menus'
import { GraphIndex } from './graph-data'
import {
  GlobalGraphView,
  LocalGraphButton,
  LocalGraphView,
  SideBarMenuItemGraph,
  globalGraph,
  localGraph
} from './views'

/** Main layouts that hold the note list and editor. */
const MAIN_LAYOUTS = ['main:full', 'main:slim']

class GraphViewPlugin implements IInkdropPlugin {
  config = { language: languageConfig }
  private menus: { dispose(): void } | null = null
  private languageWatch: { dispose(): void } | null = null
  private index: GraphIndex | null = null
  private commands: { dispose(): void } | null = null

  activate(env: Environment) {
    setEnv(env)

    this.index = new GraphIndex()
    this.index.start().catch(err => {
      console.error('[graph-view] failed to index notes:', err)
      env.notifications.addError(tr('Graph View: Failed to load notes', 'Graph View: ノートの読み込みに失敗しました'), {
        detail: err instanceof Error ? err.message : String(err),
        dismissable: true
      })
    })

    env.components.registerClass(LocalGraphButton, 'GraphViewLocalButton')
    env.layouts.insertComponentToLayoutBefore('editor-header', 'EditorHeaderMore', 'GraphViewLocalButton')
    env.components.registerClass(LocalGraphView, 'GraphViewLocal')
    env.components.registerClass(GlobalGraphView, 'GraphViewGlobal')
    for (const layout of MAIN_LAYOUTS) {
      env.layouts.insertComponentToLayoutAfter(layout, 'EditorLayout', 'GraphViewLocal')
      env.layouts.insertComponentToLayoutBefore(layout, 'NoteListBarLayout', 'GraphViewGlobal')
    }
    if (env.isMainWindow) {
      env.components.registerClass(SideBarMenuItemGraph, 'GraphViewSideBarMenuItem')
      env.layouts.insertComponentToLayoutAfter('sidebar-menu', 'SideBarMenuItemTemplates', 'GraphViewSideBarMenuItem')
    }

    this.commands = env.commands.add(document.body, {
      'graph-view:show': {
        description: tr('Graph View: Show graph view', 'Graph View: グラフビューを表示'),
        didDispatch: () => globalGraph.set(true)
      },
      'graph-view:toggle': {
        description: tr('Graph View: Toggle graph view', 'Graph View: グラフビューの表示を切り替え'),
        didDispatch: () => globalGraph.set(!globalGraph.get())
      },
      'graph-view:toggle-local': {
        description: tr("Graph View: Toggle local graph (the open note's connections)", 'Graph View: ローカルグラフ（開いているノートのつながり）の表示を切り替え'),
        didDispatch: () => localGraph.set(!localGraph.get())
      }
    } as any)
    this.menus = addMenus(env)
    this.languageWatch = env.config.onDidChange('graph-view.language', () => {
      this.menus?.dispose()
      this.menus = addMenus(env)
    })
  }

  deactivate(env: Environment) {
    this.commands?.dispose()
    this.commands = null
    this.menus?.dispose()
    this.menus = null
    this.languageWatch?.dispose()
    this.languageWatch = null
    env.layouts.removeComponentFromLayout('sidebar-menu', 'GraphViewSideBarMenuItem')
    env.components.deleteClass(SideBarMenuItemGraph, 'GraphViewSideBarMenuItem')
    for (const layout of MAIN_LAYOUTS) {
      env.layouts.removeComponentFromLayout(layout, 'GraphViewGlobal')
      env.layouts.removeComponentFromLayout(layout, 'GraphViewLocal')
    }
    env.components.deleteClass(GlobalGraphView, 'GraphViewGlobal')
    env.components.deleteClass(LocalGraphView, 'GraphViewLocal')
    env.layouts.removeComponentFromLayout('editor-header', 'GraphViewLocalButton')
    env.components.deleteClass(LocalGraphButton, 'GraphViewLocalButton')
    this.index?.stop()
    this.index = null
    globalGraph.set(false)
    setEnv(undefined)
  }
}

export default new GraphViewPlugin()
