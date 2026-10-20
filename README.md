# graph-view

**English** | [日本語](https://github.com/oba18/inkdrop-graph-view/blob/main/README.ja.md)

Shows the links between your notes (`[title](inkdrop://note/…)`) as a network, like Obsidian's graph view.

## Installation

Search for `graph-view` in Inkdrop's Preferences → Plugins, or run:

```sh
ipm install graph-view
```

Works with the Inkdrop 6+ desktop app. The keyboard shortcuts are for macOS (on Windows / Linux, use the Plugins menu or the commands).

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

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Language | `auto` | UI language: `en` (English) / `ja` (Japanese). `auto` uses Japanese if it is one of your system languages, otherwise English |

## License

MIT. The built files bundle [d3-force](https://github.com/d3/d3-force) and its dependencies (ISC License). See `THIRD_PARTY_LICENSES` for their licenses.

## Development

```sh
npm install
npm run dev   # watch-build into lib/
```
