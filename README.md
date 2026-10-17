# graph-view

**English** | [日本語](#日本語)

Shows the links between your notes (`[title](inkdrop://note/…)`) as a network, like Obsidian's graph view.

## Installation

Search for `graph-view` in Inkdrop's Preferences → Plugins, or run:

```sh
ipm install graph-view
```

Works with the Inkdrop 6+ desktop app. The keyboard shortcuts are for macOS (on Windows / Linux, use the Plugins menu or the commands). The plugin's UI text is currently in Japanese.

## Usage

- **Global graph**: **Graph** in the sidebar (or `⌘⌥G`). Shown in place of the note list and editor
- **Local graph**: The graph button at the top of the editor (or `⌘⌥L`). Shows only the notes connected to the open note, to the right of the editor (drag its left edge to resize)

| Action | What it does |
| --- | --- |
| Click a note | Open the note |
| Hover over a note | Highlight its connected notes and links |
| Drag a note | Move it (it returns to the simulation when released) |
| Drag the background / scroll | Pan / zoom (double-click the background to zoom in) |
| Click a tag node | Filter by that tag |

Notes with more links are drawn larger.

## Settings panel (gear icon, top right)

- **Filters**: Search (`tag:name` `book:notebook` `status:active` `title:…` `body:…`; prefix with `-` to exclude; space-separated terms are ANDed), show tags as nodes, orphan notes, and completed / dropped notes. In the local graph: depth (1–5), incoming / outgoing links, and links between neighbors
- **Regions**: Group notes into regions by tag (or notebook), with a background and label for each. With tags, each note goes into the region of its most widely used tag. Tune with the cohesion strength and the number of regions; choose "none" for the plain layout
- **Groups**: Color notes by search query. "Color by notebook" creates one group per top-level notebook
- **Display**: Arrows, label fade, node size, link thickness, and an animation that shows notes in the order they were created
- **Forces**: Center force, repel force, link force, and link distance

The global graph and the local graph keep separate settings.

## License

MIT. The built files bundle [d3-force](https://github.com/d3/d3-force) and its dependencies (ISC License). See `THIRD_PARTY_LICENSES` for their licenses.

## Development

```sh
npm install
npm run dev   # watch-build into lib/
```

---

# 日本語

[English](#graph-view) | **日本語**

Obsidian のグラフビューのように、ノート同士のリンク（`[タイトル](inkdrop://note/…)`）をネットワークとして表示するプラグインです。

## インストール

Inkdrop の「設定 → Plugins」で `graph-view` を検索してインストールするか、ターミナルで:

```sh
ipm install graph-view
```

Inkdrop 6 以降のデスクトップ版で動きます。ショートカットは macOS 用です（Windows / Linux ではメニュー「Plugins」やコマンドから使えます）。

## 使い方

- **グラフ全体**: サイドバーの **Graph**（または `⌘⌥G`）。ノート一覧とエディタの位置に表示されます
- **ローカルグラフ**: エディタ上部のグラフボタン（または `⌘⌥L`）。開いているノートとつながったノートだけを、エディタの右側に表示します（左端をドラッグで幅を変更）

| 操作 | 動作 |
| --- | --- |
| ノートをクリック | そのノートを開く |
| ノートにマウスを乗せる | つながったノートとリンクを強調 |
| ノートをドラッグ | 動かす（離すと元の力に戻る） |
| 背景をドラッグ / ホイール | 移動 / 拡大縮小（背景のダブルクリックでも拡大） |
| タグのノードをクリック | そのタグで絞り込む |

リンクの多いノートほど大きく表示されます。

## 設定パネル（右上の歯車）

- **フィルター**: 検索（`tag:名前` `book:ノートブック` `status:active` `title:…` `body:…`、先頭に `-` で除外、スペース区切りで AND）、タグをノードとして表示、孤立したノート、完了・中止のノート。ローカルグラフでは深さ（1〜5）、リンク元・リンク先、近傍のリンク
- **領域**: ノートをタグ（またはノートブック）ごとの領域にまとめ、背景と名前を描く。タグでは各ノートの一番多く使われているタグの領域に入る。「まとまりの強さ」「領域の数」で調整、「なし」で従来の表示
- **グループ**: 検索条件ごとに色を付ける。「ノートブックで色分け」で最上位のノートブックごとに一括作成
- **表示**: 矢印、文字のフェード、ノードの大きさ、リンクの太さ、アニメーション（ノートを作成順に表示）
- **フォース**: 中心力、反発力、リンクの力、リンクの距離

設定はグラフ全体とローカルグラフで別々に保存されます。

## ライセンス

MIT。ビルド済みファイルには [d3-force](https://github.com/d3/d3-force) ほか（ISC ライセンス）を同梱しています。各ライセンスは `THIRD_PARTY_LICENSES` を参照してください。

## 開発

```sh
npm install
npm run dev   # lib/ をウォッチビルド
```
