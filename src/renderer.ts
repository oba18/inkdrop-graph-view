import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation
} from 'd3-force'

import type { GLink, GNode, GraphData, GraphSettings, Region } from './graph-model'

export interface RendererCallbacks {
  onOpen(node: GNode, e: { metaKey: boolean; shiftKey: boolean }): void
  onHover(node: GNode | null): void
}

interface Colors {
  background: string
  node: string
  tag: string
  link: string
  text: string
  accent: string
}

type Pointer =
  | { mode: 'idle' }
  | { mode: 'pan'; startX: number; startY: number; tx: number; ty: number; moved: boolean }
  | { mode: 'node'; node: GNode; startX: number; startY: number; moved: boolean }

const MIN_ZOOM = 0.03
const MAX_ZOOM = 8
const CLICK_SLOP = 4

/** Parses `rgb(…)` / `rgba(…)` / `#rrggbb` into components. */
function parseColor(c: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(c)
  if (srgb) return [1, 2, 3].map(i => Math.round(Number(srgb[i]) * 255)) as [number, number, number]
  const h = /^#([0-9a-f]{6})$/i.exec(c.trim())
  if (h) return [0, 2, 4].map(i => parseInt(h[1].slice(i, i + 2), 16)) as [number, number, number]
  return null
}

/**
 * Resolves a CSS color (theme variables, `light-dark()`, `hsl()`…) to the
 * `rgb()` form the canvas and `withAlpha` understand.
 */
function resolveColor(host: Element, css: string): string {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = css
  host.appendChild(probe)
  const c = getComputedStyle(probe).color
  probe.remove()
  return c
}

function withAlpha(c: string, a: number): string {
  const p = parseColor(c)
  return p ? `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${a})` : c
}

type Pt = [number, number]

/** Convex hull (monotone chain), counter-clockwise. */
function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice()
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** Region-center key for the notes in no region */
const OTHERS = '\u0000others'

/**
 * Draws a force-directed graph on a canvas, Obsidian-style: grey nodes sized
 * by their link count, labels that fade in as you zoom, and hover highlighting
 * of a node's neighbors.
 */
export class GraphRenderer {
  private ctx: CanvasRenderingContext2D
  private sim: Simulation<GNode, GLink>
  private nodes: GNode[] = []
  private links: GLink[] = []
  private regions: Region[] = []
  /** World position each region's notes are pulled toward */
  private regionCenters = new Map<string, { x: number; y: number; r: number }>()
  private byId = new Map<string, GNode>()
  private neighbors = new Map<string, Set<string>>()
  private settings!: GraphSettings
  private colors!: Colors
  private width = 0
  private height = 0
  private dpr = 1
  /** View transform: screen = world * k + (x, y) */
  private t = { x: 0, y: 0, k: 1 }
  private pointer: Pointer = { mode: 'idle' }
  private hover: GNode | null = null
  private focusId: string | null = null
  private frame = 0
  private fitPending = true
  private ticksSinceData = 0
  /** Animate: only nodes created before this are drawn */
  private revealUntil: number | null = null
  private revealTimer: ReturnType<typeof setInterval> | null = null
  private outlines: Array<{ region: Region; hull: Pt[] }> = []
  private resizeObserver: ResizeObserver
  private disposed = false

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: RendererCallbacks
  ) {
    this.ctx = canvas.getContext('2d')!
    this.sim = forceSimulation<GNode, GLink>()
      .force(
        'link',
        forceLink<GNode, GLink>().id(d => d.id)
      )
      .force('charge', forceManyBody<GNode>().theta(0.5).distanceMax(2000))
      .force('x', forceX<GNode>(0))
      .force('y', forceY<GNode>(0))
      .force('collide', forceCollide<GNode>(d => this.radius(d) + 2).strength(0.3))
      .alphaDecay(0.02)
      .velocityDecay(0.4)
      .on('tick', () => {
        // Frame the graph once while it spreads out, and again when it settles.
        if (this.fitPending) {
          this.ticksSinceData++
          if (this.ticksSinceData === 30) this.fit(false)
          if (this.sim.alpha() < 0.08) {
            this.fitPending = false
            this.fit()
          }
        }
        this.requestDraw()
      })
      .stop()

    this.readColors()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement ?? canvas)
    this.resize()

    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('dblclick', this.onDoubleClick)
  }

  dispose() {
    this.disposed = true
    this.sim.stop()
    this.sim.on('tick', null)
    if (this.revealTimer) clearInterval(this.revealTimer)
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    const c = this.canvas
    c.removeEventListener('wheel', this.onWheel)
    c.removeEventListener('pointerdown', this.onPointerDown)
    c.removeEventListener('pointermove', this.onPointerMove)
    c.removeEventListener('pointerup', this.onPointerUp)
    c.removeEventListener('pointerleave', this.onPointerLeave)
    c.removeEventListener('dblclick', this.onDoubleClick)
  }

  /** Theme colors, from the CSS of the canvas's container. */
  readColors() {
    const host = this.canvas.parentElement ?? this.canvas
    const cs = getComputedStyle(host)
    const text = cs.color || '#888'
    this.colors = {
      background: cs.backgroundColor,
      text,
      node: withAlpha(text, 0.55),
      tag: resolveColor(host, 'var(--color-green-500, #57ab5a)'),
      link: withAlpha(text, 0.22),
      accent: resolveColor(host, 'var(--graph-accent, var(--primary-color, #8a5cf5))')
    }
    this.requestDraw()
  }

  setSettings(settings: GraphSettings) {
    const prev = this.settings
    this.settings = settings
    const link = this.sim.force('link') as ForceLink<GNode, GLink>
    link
      .distance(settings.linkDistance * 0.3)
      .strength(l => {
        const s = l.source as GNode
        const t = l.target as GNode
        // Links between regions pull less, so the regions stay apart.
        const across = this.regions.length && s.region !== t.region ? 1 - settings.regionForce * 0.95 : 1
        return (settings.linkForce * across) / Math.max(1, Math.min(s.degree || 1, t.degree || 1))
      })
    ;(this.sim.force('charge') as ReturnType<typeof forceManyBody<GNode>>).strength(-settings.repelForce * 25)
    // Each note is pulled toward its region's center (the graph's center when it has none).
    this.layoutRegions()
    const target = (d: GNode) => this.regionCenters.get(d.region ?? (d.kind === 'note' ? OTHERS : ''))
    const pull = (d: GNode) =>
      settings.centerForce * 0.12 + (target(d) && settings.regionForce ? 0.03 + settings.regionForce * 0.3 : 0)
    ;(this.sim.force('x') as ReturnType<typeof forceX<GNode>>).x(d => target(d)?.x ?? 0).strength(pull)
    ;(this.sim.force('y') as ReturnType<typeof forceY<GNode>>).y(d => target(d)?.y ?? 0).strength(pull)
    ;(this.sim.force('collide') as ReturnType<typeof forceCollide<GNode>>).radius(d => this.radius(d) + 2)
    const forcesChanged =
      !prev ||
      prev.linkDistance !== settings.linkDistance ||
      prev.linkForce !== settings.linkForce ||
      prev.repelForce !== settings.repelForce ||
      prev.centerForce !== settings.centerForce ||
      prev.regionForce !== settings.regionForce ||
      prev.nodeSize !== settings.nodeSize
    if (forcesChanged && this.nodes.length) this.sim.alpha(Math.max(this.sim.alpha(), 0.3)).restart()
    this.requestDraw()
  }

  /** The note to ring (the open note / local graph center). */
  setFocus(id: string | null) {
    this.focusId = id
    this.requestDraw()
  }

  setData(data: GraphData) {
    const old = this.byId
    const isFirst = this.nodes.length === 0
    // Keep positions of nodes that stay, so the graph doesn't jump on every edit.
    const nodes = data.nodes.map(n => {
      const prev = old.get(n.id)
      return prev ? Object.assign(prev, { ...n, x: prev.x, y: prev.y, vx: prev.vx, vy: prev.vy }) : { ...n }
    })
    this.byId = new Map(nodes.map(n => [n.id, n]))
    this.neighbors = new Map()
    for (const l of data.links) {
      const s = typeof l.source === 'string' ? l.source : l.source.id
      const t = typeof l.target === 'string' ? l.target : l.target.id
      if (!this.neighbors.has(s)) this.neighbors.set(s, new Set())
      if (!this.neighbors.has(t)) this.neighbors.set(t, new Set())
      this.neighbors.get(s)!.add(t)
      this.neighbors.get(t)!.add(s)
    }
    // New nodes start next to a neighbor that already has a place. On the
    // first load d3 lays them out itself, in an even spiral.
    let added = 0
    for (const n of nodes) {
      if (n.x !== undefined || isFirst) continue
      added++
      const anchor = [...(this.neighbors.get(n.id) ?? [])].map(id => this.byId.get(id)).find(m => m?.x !== undefined)
      n.x = (anchor?.x ?? 0) + (Math.random() - 0.5) * 30
      n.y = (anchor?.y ?? 0) + (Math.random() - 0.5) * 30
    }
    this.nodes = nodes
    this.links = data.links.map(l => ({ ...l }))
    const regionsChanged =
      this.regions.length !== data.regions.length || this.regions.some((r, i) => r.id !== data.regions[i].id)
    this.regions = data.regions
    if (!isFirst && regionsChanged) {
      // Regions moved: let every note find its new place, then frame it again.
      this.sim.alpha(Math.max(this.sim.alpha(), 0.6))
      this.fitPending = true
      this.ticksSinceData = 30
    }
    if (this.hover && !this.byId.has(this.hover.id)) this.setHover(null)

    if (isFirst && this.regions.length && this.settings) {
      // Start each note inside its region, so the layout settles quickly.
      this.layoutRegions()
      for (const n of this.nodes) {
        const c = this.regionCenters.get(n.region ?? (n.kind === 'note' ? OTHERS : ''))
        if (!c) continue
        const a = Math.random() * Math.PI * 2
        const d = Math.sqrt(Math.random()) * c.r * 0.8
        n.x = c.x + Math.cos(a) * d
        n.y = c.y + Math.sin(a) * d
      }
    }
    this.sim.nodes(this.nodes)
    ;(this.sim.force('link') as ForceLink<GNode, GLink>).links(this.links)
    // Re-apply settings so link strengths see the new degrees.
    if (this.settings) this.setSettings(this.settings)
    if (isFirst) {
      this.fitPending = true
      this.ticksSinceData = 0
      this.sim.alpha(1).restart()
    } else if (added || old.size !== nodes.length) {
      this.sim.alpha(Math.max(this.sim.alpha(), 0.3)).restart()
    } else {
      this.sim.alpha(Math.max(this.sim.alpha(), 0.05)).restart()
    }
    this.requestDraw()
  }

  /** Replays the graph growing in the order notes were created. */
  animate() {
    if (this.revealTimer) clearInterval(this.revealTimer)
    const order = this.nodes
      .filter(n => n.kind === 'note')
      .map(n => n.createdAt)
      .sort((a, b) => a - b)
    if (!order.length) return
    for (const n of this.nodes) {
      n.x = (Math.random() - 0.5) * 50
      n.y = (Math.random() - 0.5) * 50
      n.vx = n.vy = 0
    }
    const steps = Math.min(order.length, 200)
    let step = 0
    this.revealUntil = order[0]
    this.sim.alpha(1).restart()
    this.revealTimer = setInterval(() => {
      step++
      if (step >= steps) {
        this.revealUntil = null
        clearInterval(this.revealTimer!)
        this.revealTimer = null
      } else {
        this.revealUntil = order[Math.floor((order.length - 1) * (step / steps))]
      }
      this.sim.alpha(Math.max(this.sim.alpha(), 0.5))
      this.requestDraw()
    }, 40)
  }

  /** Zooms to show every node (or centers the focused node in a local graph). */
  fit(animated = true) {
    const pts = this.nodes.filter(n => n.x !== undefined)
    if (!pts.length || !this.width) return
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const n of pts) {
      const r = this.radius(n)
      x0 = Math.min(x0, n.x! - r)
      y0 = Math.min(y0, n.y! - r)
      x1 = Math.max(x1, n.x! + r)
      y1 = Math.max(y1, n.y! + r)
    }
    const pad = 40
    const k = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((this.width - pad * 2) / (x1 - x0 || 1), (this.height - pad * 2) / (y1 - y0 || 1)))
    )
    const target = {
      k: Math.min(k, 2),
      x: this.width / 2 - ((x0 + x1) / 2) * Math.min(k, 2),
      y: this.height / 2 - ((y0 + y1) / 2) * Math.min(k, 2)
    }
    if (!animated) {
      this.t = target
      this.requestDraw()
      return
    }
    const from = { ...this.t }
    const start = performance.now()
    const step = (now: number) => {
      if (this.disposed) return
      const p = Math.min(1, (now - start) / 300)
      const e = 1 - Math.pow(1 - p, 3)
      this.t = {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k + (target.k - from.k) * e
      }
      this.draw()
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  zoomBy(factor: number) {
    this.zoomAt(this.width / 2, this.height / 2, factor)
  }

  /**
   * Region centers, packed without overlap: each region is a circle sized by
   * its note count, placed biggest first at the free spot nearest the middle.
   * The notes in no region get a spot of their own too.
   */
  private layoutRegions() {
    this.regionCenters = new Map()
    if (!this.regions.length || !this.settings) return
    const spread = Math.sqrt(Math.max(1, this.settings.repelForce) / 10) * (this.settings.nodeSize ?? 1)
    const radius = (size: number) => (30 + Math.sqrt(size) * 20) * spread
    const others = this.nodes.filter(n => n.kind === 'note' && !n.region).length
    const items = [
      ...this.regions.map(r => ({ id: r.id, size: r.size })),
      ...(others ? [{ id: OTHERS, size: others }] : [])
    ].sort((a, b) => b.size - a.size)
    const placed: Array<{ x: number; y: number; r: number }> = []
    const gap = 40 * spread
    for (const item of items) {
      const r = radius(item.size)
      let x = 0
      let y = 0
      // Walk a spiral outward until the circle fits.
      for (let step = 0; placed.length && step < 20000; step++) {
        const a = step * 0.25
        const d = step * 3 * spread
        x = Math.cos(a) * d
        y = Math.sin(a) * d
        if (placed.every(p => Math.hypot(p.x - x, p.y - y) >= p.r + r + gap)) break
      }
      placed.push({ x, y, r })
      this.regionCenters.set(item.id, { x, y, r })
    }
  }

  /* ---- geometry ---- */

  private radius(n: GNode): number {
    const base = n.kind === 'tag' ? 3 : 4
    return (base + Math.min(Math.sqrt(n.degree) * 1.8, 22)) * (this.settings?.nodeSize ?? 1)
  }

  private toWorld(sx: number, sy: number) {
    return { x: (sx - this.t.x) / this.t.k, y: (sy - this.t.y) / this.t.k }
  }

  private nodeAt(sx: number, sy: number): GNode | null {
    const { x, y } = this.toWorld(sx, sy)
    let best: GNode | null = null
    let bestD = Infinity
    for (const n of this.nodes) {
      if (!this.isRevealed(n)) continue
      const r = this.radius(n) + 4 / this.t.k
      const d = (n.x! - x) ** 2 + (n.y! - y) ** 2
      if (d <= r * r && d < bestD) {
        best = n
        bestD = d
      }
    }
    return best
  }

  private isRevealed(n: GNode) {
    return this.revealUntil === null || n.kind === 'tag' || n.createdAt <= this.revealUntil
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.t.k * factor))
    const w = this.toWorld(sx, sy)
    this.t = { k, x: sx - w.x * k, y: sy - w.y * k }
    this.requestDraw()
  }

  private resize() {
    const host = this.canvas.parentElement ?? this.canvas
    const rect = host.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const first = !this.width
    // Keep the graph's center where it was.
    if (!first) {
      this.t.x += (rect.width - this.width) / 2
      this.t.y += (rect.height - this.height) / 2
    } else {
      this.t = { x: rect.width / 2, y: rect.height / 2, k: 1 }
    }
    this.width = rect.width
    this.height = rect.height
    this.dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.draw()
  }

  /* ---- input ---- */

  private local(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const p = this.local(e)
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const speed = e.ctrlKey ? 0.01 : 0.0015
    this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * speed))
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const p = this.local(e)
    const node = this.nodeAt(p.x, p.y)
    this.canvas.setPointerCapture(e.pointerId)
    if (node) {
      this.pointer = { mode: 'node', node, startX: p.x, startY: p.y, moved: false }
    } else {
      this.pointer = { mode: 'pan', startX: p.x, startY: p.y, tx: this.t.x, ty: this.t.y, moved: false }
      this.canvas.classList.add('panning')
    }
  }

  private onPointerMove = (e: PointerEvent) => {
    const p = this.local(e)
    const ptr = this.pointer
    if (ptr.mode === 'pan') {
      if (!ptr.moved && Math.hypot(p.x - ptr.startX, p.y - ptr.startY) < CLICK_SLOP) return
      ptr.moved = true
      this.t.x = ptr.tx + (p.x - ptr.startX)
      this.t.y = ptr.ty + (p.y - ptr.startY)
      this.requestDraw()
      return
    }
    if (ptr.mode === 'node') {
      if (!ptr.moved && Math.hypot(p.x - ptr.startX, p.y - ptr.startY) < CLICK_SLOP) return
      if (!ptr.moved) {
        ptr.moved = true
        this.sim.alphaTarget(0.3).restart()
      }
      const w = this.toWorld(p.x, p.y)
      ptr.node.fx = w.x
      ptr.node.fy = w.y
      return
    }
    const node = this.nodeAt(p.x, p.y)
    if (node !== this.hover) this.setHover(node)
  }

  private onPointerUp = (e: PointerEvent) => {
    const ptr = this.pointer
    this.pointer = { mode: 'idle' }
    this.canvas.classList.remove('panning')
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (ptr.mode !== 'node') return
    if (ptr.moved) {
      // Let go, like Obsidian: the node rejoins the simulation.
      ptr.node.fx = null
      ptr.node.fy = null
      this.sim.alphaTarget(0)
      return
    }
    this.callbacks.onOpen(ptr.node, { metaKey: e.metaKey || e.ctrlKey, shiftKey: e.shiftKey })
  }

  private onPointerLeave = () => {
    if (this.pointer.mode === 'idle') this.setHover(null)
  }

  private onDoubleClick = (e: MouseEvent) => {
    const p = this.local(e)
    if (!this.nodeAt(p.x, p.y)) this.zoomAt(p.x, p.y, 1.6)
  }

  private setHover(node: GNode | null) {
    this.hover = node
    this.canvas.style.cursor = node ? 'pointer' : ''
    this.callbacks.onHover(node)
    this.requestDraw()
  }

  /* ---- drawing ---- */

  private requestDraw() {
    if (this.frame || this.disposed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  private labelAlpha(): number {
    // Obsidian's "text fade threshold": labels appear as you zoom in.
    const threshold = 1.1 * Math.pow(2, (this.settings?.textFade ?? 0) / 1.5)
    return Math.max(0, Math.min(1, (this.t.k - threshold * 0.6) / (threshold * 0.5)))
  }

  private draw() {
    if (this.disposed || !this.width || !this.settings) return
    const { ctx, colors, settings } = this
    const { k } = this.t
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * this.t.x, this.dpr * this.t.y)

    const hover = this.hover
    const lit = hover ? new Set([hover.id, ...(this.neighbors.get(hover.id) ?? [])]) : null
    const dim = (id: string) => !!lit && !lit.has(id)

    if (settings.showRegions && this.regions.length) this.drawRegions(!!lit)

    // Links
    const linkWidth = (settings.linkThickness * 1) / Math.max(k, 0.35)
    for (const l of this.links) {
      const s = l.source as GNode
      const t = l.target as GNode
      if (!this.isRevealed(s) || !this.isRevealed(t)) continue
      const active = !!hover && (s.id === hover.id || t.id === hover.id)
      ctx.strokeStyle = active ? colors.accent : lit ? withAlpha(colors.text, 0.06) : colors.link
      ctx.lineWidth = active ? linkWidth * 1.8 : linkWidth
      ctx.beginPath()
      ctx.moveTo(s.x!, s.y!)
      ctx.lineTo(t.x!, t.y!)
      ctx.stroke()
      if (settings.arrows) this.drawArrow(s, t, active ? colors.accent : ctx.strokeStyle, linkWidth)
    }

    // Nodes
    for (const n of this.nodes) {
      if (!this.isRevealed(n)) continue
      const r = this.radius(n)
      let fill = n.color ?? (n.kind === 'tag' ? colors.tag : colors.node)
      if (hover && n.id === hover.id) fill = colors.accent
      ctx.globalAlpha = dim(n.id) ? 0.2 : 1
      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2)
      ctx.fill()
      if (n.id === this.focusId) {
        ctx.strokeStyle = colors.accent
        ctx.lineWidth = Math.max(2, 2.5 / k)
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, r + Math.max(2, 3 / k), 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // Labels
    const base = this.labelAlpha()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const n of this.nodes) {
      if (!this.isRevealed(n)) continue
      const always = (lit && lit.has(n.id)) || n.id === this.focusId
      let a = always ? 1 : base
      if (lit && !lit.has(n.id)) a *= 0.2
      if (a <= 0.02) continue
      // Keep labels readable when zoomed out on a hovered node.
      const size = always && k < 1 ? 12 / k : 12
      ctx.font = `${size}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`
      ctx.globalAlpha = a
      ctx.fillStyle = colors.text
      const label = n.label.length > 40 ? `${n.label.slice(0, 39)}…` : n.label
      ctx.fillText(label, n.x!, n.y! + this.radius(n) + 4)
    }
    ctx.globalAlpha = 1

    if (settings.showRegions && this.regions.length) this.drawRegionLabels(!!lit)
  }

  /** Each region's outline: its notes' hull, padded and rounded. */
  private regionOutlines(): Array<{ region: Region; hull: Pt[] }> {
    const members = new Map<string, Pt[]>()
    for (const n of this.nodes) {
      if (n.x === undefined || !this.isRevealed(n) || (!n.region && n.kind !== 'note')) continue
      const key = n.region ?? OTHERS
      const list = members.get(key)
      const p: Pt = [n.x, n.y!]
      if (list) list.push(p)
      else members.set(key, [p])
    }
    const others: Region = { id: OTHERS, label: 'その他', color: this.colors.text, size: members.get(OTHERS)?.length ?? 0 }
    const pad = 26 * (this.settings.nodeSize ?? 1)
    const out: Array<{ region: Region; hull: Pt[] }> = []
    for (const region of [...this.regions, others]) {
      const all = members.get(region.id)
      if (!all) continue
      // Notes pulled far out by links elsewhere would stretch the outline; leave them out.
      const cx = all.reduce((sum, p) => sum + p[0], 0) / all.length
      const cy = all.reduce((sum, p) => sum + p[1], 0) / all.length
      const dist = all.map(p => Math.hypot(p[0] - cx, p[1] - cy))
      const median = dist.slice().sort((a, b) => a - b)[Math.floor(dist.length / 2)]
      const limit = Math.max(median * 2.2, pad * 3)
      const pts = all.filter((_, i) => dist[i] <= limit)
      // Pad around the corners of the hull of the centers.
      const ring: Pt[] = []
      for (const [x, y] of convexHull(pts)) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2
          ring.push([x + Math.cos(a) * pad, y + Math.sin(a) * pad])
        }
      }
      out.push({ region, hull: convexHull(ring) })
    }
    return out
  }

  private drawRegions(dimmed: boolean) {
    const { ctx } = this
    this.outlines = this.regionOutlines()
    for (const { region, hull } of this.outlines) {
      if (hull.length < 3) continue
      ctx.beginPath()
      // Through the edge midpoints, so the corners come out round.
      const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const start = mid(hull[hull.length - 1], hull[0])
      ctx.moveTo(start[0], start[1])
      for (let i = 0; i < hull.length; i++) {
        const m = mid(hull[i], hull[(i + 1) % hull.length])
        ctx.quadraticCurveTo(hull[i][0], hull[i][1], m[0], m[1])
      }
      ctx.closePath()
      const isOthers = region.id === OTHERS
      if (!isOthers) {
        ctx.fillStyle = withAlpha(region.color, dimmed ? 0.03 : 0.08)
        ctx.fill()
      }
      // The rest of the notes get just a faint dashed edge.
      ctx.setLineDash(isOthers ? [6 / this.t.k, 6 / this.t.k] : [])
      ctx.strokeStyle = withAlpha(region.color, isOthers ? 0.15 : dimmed ? 0.12 : 0.4)
      ctx.lineWidth = 1.5 / this.t.k
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  /** Region names above their outlines, at a fixed size on screen. */
  private drawRegionLabels(dimmed: boolean) {
    const { ctx } = this
    const k = this.t.k
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const { region, hull } of this.outlines) {
      if (!hull.length) continue
      let top = Infinity
      let x0 = Infinity
      let x1 = -Infinity
      for (const [x, y] of hull) {
        top = Math.min(top, y)
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
      }
      ctx.font = `600 ${15 / k}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`
      ctx.globalAlpha = (dimmed ? 0.3 : 1) * (region.id === OTHERS ? 0.45 : 1)
      ctx.fillStyle = region.color
      ctx.fillText(`${region.label}  ${region.size}`, (x0 + x1) / 2, top - 4 / k)
    }
    ctx.globalAlpha = 1
  }

  private drawArrow(s: GNode, t: GNode, color: string | CanvasGradient | CanvasPattern, width: number) {
    const { ctx } = this
    const dx = t.x! - s.x!
    const dy = t.y! - s.y!
    const len = Math.hypot(dx, dy)
    if (len < 1) return
    const ux = dx / len
    const uy = dy / len
    const r = this.radius(t)
    const tipX = t.x! - ux * (r + 1)
    const tipY = t.y! - uy * (r + 1)
    const size = Math.max(4, width * 4)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5)
    ctx.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5)
    ctx.closePath()
    ctx.fill()
  }
}
