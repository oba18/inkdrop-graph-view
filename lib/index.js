//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/env.ts
/**
* Captures the `Environment` handed to `activate()` so other modules can reach
* it without the (discouraged) global `inkdrop`.
*/
let captured;
function setEnv(env) {
	captured = env;
}
/** The env, or `undefined` once the plugin is deactivated. */
function peekEnv() {
	return captured;
}
function getEnv() {
	if (!captured) throw new Error("[graph-view] env accessed before activate()");
	return captured;
}
/** Opens a note in the editor and brings the window forward. */
function openNote(noteId) {
	const env = getEnv();
	env.window.show();
	env.window.focus();
	env.commands.dispatch(document.body, "core:open-note", {
		noteId,
		selectInNoteListBar: true
	});
}
//#endregion
//#region src/graph-data.ts
const PAGE_SIZE = 500;
/** `[label](inkdrop://note/ID)`, and the older `inkdrop://note:ID` form. */
const LINK_RE = /inkdrop:\/\/note[/:]([A-Za-z0-9_-]+)/g;
const FENCE_RE = /^\s*(```|~~~)/;
/** Note ids linked from a note body, skipping fenced code blocks. */
function parseLinks(body) {
	const out = /* @__PURE__ */ new Set();
	if (!body.includes("inkdrop://note")) return out;
	let inFence = false;
	for (const line of body.split("\n")) {
		if (FENCE_RE.test(line)) inFence = !inFence;
		if (inFence) continue;
		for (const m of line.matchAll(LINK_RE)) out.add(`note:${m[1]}`);
	}
	return out;
}
let current = null;
/** The running index, or `null` before start / after stop. */
function getIndex() {
	return current;
}
/**
* In-memory index of every note (trash and templates excluded) with the links
* between them, kept up to date from database changes.
*/
var GraphIndex = class {
	notes = /* @__PURE__ */ new Map();
	tags = /* @__PURE__ */ new Map();
	started = false;
	/** Bumped on every change, so views can cheaply tell when to rebuild. */
	version = 0;
	listeners = /* @__PURE__ */ new Set();
	subs = [];
	emitTimer = null;
	async start() {
		current = this;
		const env = getEnv();
		this.subs.push(env.localDB.onNoteChange((change) => {
			this.handleChange(change).catch((err) => console.error("[graph-view] change failed:", err));
		}), env.localDB.onTagChange(() => {
			this.loadTags().catch((err) => console.error("[graph-view] tag load failed:", err));
		}));
		await this.loadTags();
		for (let skip = 0;; skip += PAGE_SIZE) {
			const res = await env.localDB.notes.all({
				limit: PAGE_SIZE,
				skip,
				pinnedFirst: false,
				sort: [{ createdAt: "asc" }]
			});
			const docs = res.docs ?? res.rows?.map((r) => r.doc).filter(Boolean) ?? [];
			for (const doc of docs) this.index(doc);
			if (docs.length < PAGE_SIZE) break;
		}
		for (const status of ["completed", "dropped"]) for (let skip = 0;; skip += PAGE_SIZE) {
			const docs = (await env.localDB.notes.findWithStatus(status, {
				limit: PAGE_SIZE,
				skip
			})).docs ?? [];
			for (const doc of docs) this.index(doc);
			if (docs.length < PAGE_SIZE) break;
		}
		this.started = true;
		this.emit();
		console.info(`[graph-view] indexed ${this.notes.size} notes`);
	}
	stop() {
		for (const s of this.subs) s.dispose();
		this.subs = [];
		if (this.emitTimer) clearTimeout(this.emitTimer);
		this.notes.clear();
		this.listeners.clear();
		this.started = false;
		if (current === this) current = null;
	}
	onDidChange(listener) {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}
	emit() {
		this.version++;
		for (const l of this.listeners) l();
	}
	/** Coalesces bursts of changes (sync, bulk edits) into one update. */
	emitSoon() {
		if (this.emitTimer) clearTimeout(this.emitTimer);
		this.emitTimer = setTimeout(() => {
			this.emitTimer = null;
			this.emit();
		}, 200);
	}
	async loadTags() {
		const tags = await getEnv().localDB.tags.all();
		this.tags = new Map(tags.map((t) => [t._id, t.name]));
		if (this.started) this.emitSoon();
	}
	async handleChange(change) {
		const id = change.id ?? change.doc?._id ?? change._id;
		if (!id?.startsWith("note:")) return;
		if (change.deleted || change.doc?._deleted) {
			if (this.notes.delete(id)) this.emitSoon();
			return;
		}
		const inline = change.doc ?? (change.body !== void 0 ? change : void 0);
		const note = inline?.body !== void 0 ? inline : await getEnv().localDB.notes.get(id).catch(() => void 0);
		if (note) {
			if (!this.index(note)) return;
		} else this.notes.delete(id);
		this.emitSoon();
	}
	/** Returns `false` when nothing the graph shows changed. */
	index(note) {
		if (note.bookId === "trash" || note.bookId === "template") return this.notes.delete(note._id);
		const body = note.body ?? "";
		const prev = this.notes.get(note._id);
		const entry = {
			id: note._id,
			title: note.title || "",
			bookId: note.bookId,
			tagIds: note.tags ?? [],
			status: note.status,
			createdAt: note.createdAt,
			updatedAt: note.updatedAt,
			text: body.toLowerCase(),
			links: parseLinks(body)
		};
		this.notes.set(note._id, entry);
		if (!prev) return true;
		return prev.title !== entry.title || prev.bookId !== entry.bookId || prev.status !== entry.status || prev.tagIds.join() !== entry.tagIds.join() || prev.links.size !== entry.links.size || [...entry.links].some((l) => !prev.links.has(l));
	}
};
//#endregion
//#region src/graph-model.ts
const DEFAULT_SETTINGS = {
	search: "",
	showTags: false,
	showOrphans: true,
	showClosed: true,
	depth: 1,
	showIncoming: true,
	showOutgoing: true,
	neighborLinks: true,
	groups: [],
	regionBy: "tag",
	showRegions: true,
	regionForce: .5,
	maxRegions: 12,
	arrows: false,
	textFade: 0,
	nodeSize: 1,
	linkThickness: 1,
	centerForce: .5,
	repelForce: 10,
	linkForce: 1,
	linkDistance: 250,
	open: {
		filters: true,
		regions: false,
		groups: false,
		display: false,
		forces: false
	}
};
const storageKey = (kind) => `inkdrop-graph-view:settings:${kind}`;
function loadSettings(kind) {
	const base = kind === "local" ? {
		...DEFAULT_SETTINGS,
		textFade: -1.5
	} : DEFAULT_SETTINGS;
	try {
		const saved = JSON.parse(localStorage.getItem(storageKey(kind)) ?? "{}");
		return {
			...base,
			...saved,
			open: {
				...base.open,
				...saved.open
			}
		};
	} catch {
		return { ...base };
	}
}
function saveSettings(kind, s) {
	try {
		localStorage.setItem(storageKey(kind), JSON.stringify(s));
	} catch {}
}
/** Distinct, mid-saturation colors that read on light and dark themes. */
const PALETTE = [
	"#e5534b",
	"#e0823d",
	"#c69026",
	"#57ab5a",
	"#39c5bb",
	"#539bf5",
	"#986ee2",
	"#e275ad",
	"#8ddb8c",
	"#f69d50"
];
/** `foo "bar baz" tag:x book:"My Book" -status:dropped` → terms (all must match). */
function parseQuery(q) {
	const terms = [];
	for (const m of q.matchAll(/(-)?(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g)) {
		const value = (m[3] ?? m[4] ?? "").toLowerCase();
		if (!value) continue;
		terms.push({
			neg: !!m[1],
			key: m[2]?.toLowerCase() ?? null,
			value
		});
	}
	return terms;
}
/** The note's notebook and every notebook above it. */
function bookNames(bookId, ctx) {
	const names = [];
	const seen = /* @__PURE__ */ new Set();
	for (let id = bookId; id && !seen.has(id); id = ctx.books[id]?.parentBookId) {
		seen.add(id);
		if (ctx.books[id]) names.push(ctx.books[id].name.toLowerCase());
	}
	return names;
}
function termMatches(note, t, ctx) {
	switch (t.key) {
		case "tag": return note.tagIds.some((id) => (ctx.tags.get(id) ?? "").toLowerCase() === t.value);
		case "book":
		case "notebook": return bookNames(note.bookId, ctx).some((n) => n.includes(t.value));
		case "status": return (note.status ?? "none").toLowerCase() === t.value;
		case "title": return note.title.toLowerCase().includes(t.value);
		case "body": return note.text.includes(t.value);
		default: return note.title.toLowerCase().includes(t.value) || note.text.includes(t.value);
	}
}
/** Compiles a query into a note predicate; an empty query matches everything. */
function compileQuery(q, ctx) {
	const terms = parseQuery(q);
	if (!terms.length) return null;
	return (note) => terms.every((t) => termMatches(note, t, ctx) !== t.neg);
}
const CLOSED = /* @__PURE__ */ new Set(["completed", "dropped"]);
/**
* Nodes and links for the current settings. For the local graph, `center` is
* the note at the middle; the result holds the notes within `depth` hops.
*/
function buildGraph(index, settings, ctx, center = null) {
	const match = compileQuery(settings.search, ctx);
	const groups = settings.groups.map((g) => ({
		color: g.color,
		test: compileQuery(g.query, ctx)
	})).filter((g) => !!g.test);
	const included = /* @__PURE__ */ new Set();
	for (const note of index.notes.values()) {
		if (!settings.showClosed && CLOSED.has(note.status ?? "") && note.id !== center) continue;
		if (match && !match(note) && note.id !== center) continue;
		included.add(note.id);
	}
	const edges = [];
	const edgeKeys = /* @__PURE__ */ new Set();
	const addEdge = (s, t) => {
		const key = `${s}\u0000${t}`;
		if (s === t || edgeKeys.has(key)) return;
		edgeKeys.add(key);
		edges.push({
			s,
			t
		});
	};
	for (const id of included) {
		const note = index.notes.get(id);
		for (const target of note.links) if (included.has(target)) addEdge(id, target);
		if (settings.showTags) {
			for (const tagId of note.tagIds) if (index.tags.has(tagId)) addEdge(id, tagId);
		}
	}
	let keep = null;
	if (center) {
		const out = /* @__PURE__ */ new Map();
		const inc = /* @__PURE__ */ new Map();
		const push = (m, k, v) => {
			const list = m.get(k);
			if (list) list.push(v);
			else m.set(k, [v]);
		};
		for (const e of edges) {
			push(out, e.s, e.t);
			push(inc, e.t, e.s);
		}
		keep = /* @__PURE__ */ new Map([[center, 0]]);
		let frontier = [center];
		for (let d = 1; d <= settings.depth && frontier.length; d++) {
			const next = [];
			for (const id of frontier) {
				const around = [
					...settings.showOutgoing ? out.get(id) ?? [] : [],
					...settings.showIncoming ? inc.get(id) ?? [] : [],
					...id.startsWith("tag:") ? [...out.get(id) ?? [], ...inc.get(id) ?? []] : []
				];
				for (const n of around) {
					if (keep.has(n)) continue;
					keep.set(n, d);
					next.push(n);
				}
			}
			frontier = next;
		}
	}
	const nodeIds = new Set(keep ? keep.keys() : included);
	if (!keep && settings.showTags) {
		for (const e of edges) if (e.t.startsWith("tag:")) nodeIds.add(e.t);
	}
	const links = edges.filter((e) => {
		if (!nodeIds.has(e.s) || !nodeIds.has(e.t)) return false;
		return !keep || settings.neighborLinks || keep.get(e.s) !== keep.get(e.t);
	});
	const degree = /* @__PURE__ */ new Map();
	for (const e of links) {
		degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
		degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
	}
	const nodes = [];
	for (const id of nodeIds) {
		const deg = degree.get(id) ?? 0;
		if (!settings.showOrphans && deg === 0 && id !== center) continue;
		if (id.startsWith("tag:")) {
			nodes.push({
				id,
				kind: "tag",
				label: `#${index.tags.get(id) ?? ""}`,
				color: null,
				region: null,
				degree: deg,
				createdAt: 0,
				depth: keep?.get(id)
			});
			continue;
		}
		const note = index.notes.get(id);
		if (!note) continue;
		const group = groups.find((g) => g.test(note));
		nodes.push({
			id,
			kind: "note",
			label: note.title || "無題のノート",
			color: group?.color ?? null,
			region: null,
			degree: deg,
			createdAt: note.createdAt,
			depth: keep?.get(id)
		});
	}
	const regions = assignRegions(nodes, index, settings, ctx);
	const shown = new Set(nodes.map((n) => n.id));
	return {
		nodes,
		links: links.filter((e) => shown.has(e.s) && shown.has(e.t)).map((e) => ({
			source: e.s,
			target: e.t
		})),
		regions
	};
}
/** The notebook at the top of `bookId`'s tree. */
function rootBook(bookId, ctx) {
	const seen = /* @__PURE__ */ new Set();
	let id = bookId;
	while (id && ctx.books[id]?.parentBookId && !seen.has(id)) {
		seen.add(id);
		id = ctx.books[id].parentBookId;
	}
	return id && ctx.books[id] ? id : null;
}
/**
* Puts each note in a region: by tag, the note's most widely used tag; by
* notebook, its top-level notebook. Only the largest `maxRegions` regions (of
* two notes or more) are kept; the rest of the notes float between them.
* Notes without a group color take their region's color.
*/
function assignRegions(nodes, index, settings, ctx) {
	if (settings.regionBy === "none") return [];
	const notes = nodes.filter((n) => n.kind === "note");
	const candidates = /* @__PURE__ */ new Map();
	for (const n of notes) {
		const note = index.notes.get(n.id);
		if (settings.regionBy === "tag") candidates.set(n, note.tagIds.filter((id) => ctx.tags.has(id)));
		else {
			const root = rootBook(note.bookId, ctx);
			candidates.set(n, root ? [root] : []);
		}
	}
	const count = /* @__PURE__ */ new Map();
	for (const ids of candidates.values()) for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
	const label = (id) => settings.regionBy === "tag" ? `#${ctx.tags.get(id) ?? ""}` : ctx.books[id]?.name ?? "";
	const pick = (ids) => ids.reduce((best, id) => !best || count.get(id) > count.get(best) || count.get(id) === count.get(best) && label(id) < label(best) ? id : best, null);
	const chosen = /* @__PURE__ */ new Map();
	const size = /* @__PURE__ */ new Map();
	for (const [n, ids] of candidates) {
		const id = pick(ids);
		if (!id) continue;
		chosen.set(n, id);
		size.set(id, (size.get(id) ?? 0) + 1);
	}
	const regions = [...size].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0]))).slice(0, Math.max(1, settings.maxRegions)).map(([id, n], i) => ({
		id,
		label: label(id),
		color: PALETTE[i % PALETTE.length],
		size: n
	}));
	const byId = new Map(regions.map((r) => [r.id, r]));
	for (const [n, id] of chosen) {
		const r = byId.get(id);
		if (!r) continue;
		n.region = id;
		n.color ??= r.color;
	}
	for (const n of nodes) {
		if (n.kind !== "tag") continue;
		const r = byId.get(n.id);
		if (r) n.region = r.id;
	}
	return regions;
}
//#endregion
//#region node_modules/d3-quadtree/src/add.js
function add_default(d) {
	const x = +this._x.call(null, d), y = +this._y.call(null, d);
	return add(this.cover(x, y), x, y, d);
}
function add(tree, x, y, d) {
	if (isNaN(x) || isNaN(y)) return tree;
	var parent, node = tree._root, leaf = { data: d }, x0 = tree._x0, y0 = tree._y0, x1 = tree._x1, y1 = tree._y1, xm, ym, xp, yp, right, bottom, i, j;
	if (!node) return tree._root = leaf, tree;
	while (node.length) {
		if (right = x >= (xm = (x0 + x1) / 2)) x0 = xm;
		else x1 = xm;
		if (bottom = y >= (ym = (y0 + y1) / 2)) y0 = ym;
		else y1 = ym;
		if (parent = node, !(node = node[i = bottom << 1 | right])) return parent[i] = leaf, tree;
	}
	xp = +tree._x.call(null, node.data);
	yp = +tree._y.call(null, node.data);
	if (x === xp && y === yp) return leaf.next = node, parent ? parent[i] = leaf : tree._root = leaf, tree;
	do {
		parent = parent ? parent[i] = new Array(4) : tree._root = new Array(4);
		if (right = x >= (xm = (x0 + x1) / 2)) x0 = xm;
		else x1 = xm;
		if (bottom = y >= (ym = (y0 + y1) / 2)) y0 = ym;
		else y1 = ym;
	} while ((i = bottom << 1 | right) === (j = (yp >= ym) << 1 | xp >= xm));
	return parent[j] = node, parent[i] = leaf, tree;
}
function addAll(data) {
	var d, i, n = data.length, x, y, xz = new Array(n), yz = new Array(n), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (i = 0; i < n; ++i) {
		if (isNaN(x = +this._x.call(null, d = data[i])) || isNaN(y = +this._y.call(null, d))) continue;
		xz[i] = x;
		yz[i] = y;
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
	}
	if (x0 > x1 || y0 > y1) return this;
	this.cover(x0, y0).cover(x1, y1);
	for (i = 0; i < n; ++i) add(this, xz[i], yz[i], data[i]);
	return this;
}
//#endregion
//#region node_modules/d3-quadtree/src/cover.js
function cover_default(x, y) {
	if (isNaN(x = +x) || isNaN(y = +y)) return this;
	var x0 = this._x0, y0 = this._y0, x1 = this._x1, y1 = this._y1;
	if (isNaN(x0)) {
		x1 = (x0 = Math.floor(x)) + 1;
		y1 = (y0 = Math.floor(y)) + 1;
	} else {
		var z = x1 - x0 || 1, node = this._root, parent, i;
		while (x0 > x || x >= x1 || y0 > y || y >= y1) {
			i = (y < y0) << 1 | x < x0;
			parent = new Array(4), parent[i] = node, node = parent, z *= 2;
			switch (i) {
				case 0:
					x1 = x0 + z, y1 = y0 + z;
					break;
				case 1:
					x0 = x1 - z, y1 = y0 + z;
					break;
				case 2:
					x1 = x0 + z, y0 = y1 - z;
					break;
				case 3: x0 = x1 - z, y0 = y1 - z;
			}
		}
		if (this._root && this._root.length) this._root = node;
	}
	this._x0 = x0;
	this._y0 = y0;
	this._x1 = x1;
	this._y1 = y1;
	return this;
}
//#endregion
//#region node_modules/d3-quadtree/src/data.js
function data_default() {
	var data = [];
	this.visit(function(node) {
		if (!node.length) do
			data.push(node.data);
		while (node = node.next);
	});
	return data;
}
//#endregion
//#region node_modules/d3-quadtree/src/extent.js
function extent_default(_) {
	return arguments.length ? this.cover(+_[0][0], +_[0][1]).cover(+_[1][0], +_[1][1]) : isNaN(this._x0) ? void 0 : [[this._x0, this._y0], [this._x1, this._y1]];
}
//#endregion
//#region node_modules/d3-quadtree/src/quad.js
function quad_default(node, x0, y0, x1, y1) {
	this.node = node;
	this.x0 = x0;
	this.y0 = y0;
	this.x1 = x1;
	this.y1 = y1;
}
//#endregion
//#region node_modules/d3-quadtree/src/find.js
function find_default(x, y, radius) {
	var data, x0 = this._x0, y0 = this._y0, x1, y1, x2, y2, x3 = this._x1, y3 = this._y1, quads = [], node = this._root, q, i;
	if (node) quads.push(new quad_default(node, x0, y0, x3, y3));
	if (radius == null) radius = Infinity;
	else {
		x0 = x - radius, y0 = y - radius;
		x3 = x + radius, y3 = y + radius;
		radius *= radius;
	}
	while (q = quads.pop()) {
		if (!(node = q.node) || (x1 = q.x0) > x3 || (y1 = q.y0) > y3 || (x2 = q.x1) < x0 || (y2 = q.y1) < y0) continue;
		if (node.length) {
			var xm = (x1 + x2) / 2, ym = (y1 + y2) / 2;
			quads.push(new quad_default(node[3], xm, ym, x2, y2), new quad_default(node[2], x1, ym, xm, y2), new quad_default(node[1], xm, y1, x2, ym), new quad_default(node[0], x1, y1, xm, ym));
			if (i = (y >= ym) << 1 | x >= xm) {
				q = quads[quads.length - 1];
				quads[quads.length - 1] = quads[quads.length - 1 - i];
				quads[quads.length - 1 - i] = q;
			}
		} else {
			var dx = x - +this._x.call(null, node.data), dy = y - +this._y.call(null, node.data), d2 = dx * dx + dy * dy;
			if (d2 < radius) {
				var d = Math.sqrt(radius = d2);
				x0 = x - d, y0 = y - d;
				x3 = x + d, y3 = y + d;
				data = node.data;
			}
		}
	}
	return data;
}
//#endregion
//#region node_modules/d3-quadtree/src/remove.js
function remove_default(d) {
	if (isNaN(x = +this._x.call(null, d)) || isNaN(y = +this._y.call(null, d))) return this;
	var parent, node = this._root, retainer, previous, next, x0 = this._x0, y0 = this._y0, x1 = this._x1, y1 = this._y1, x, y, xm, ym, right, bottom, i, j;
	if (!node) return this;
	if (node.length) while (true) {
		if (right = x >= (xm = (x0 + x1) / 2)) x0 = xm;
		else x1 = xm;
		if (bottom = y >= (ym = (y0 + y1) / 2)) y0 = ym;
		else y1 = ym;
		if (!(parent = node, node = node[i = bottom << 1 | right])) return this;
		if (!node.length) break;
		if (parent[i + 1 & 3] || parent[i + 2 & 3] || parent[i + 3 & 3]) retainer = parent, j = i;
	}
	while (node.data !== d) if (!(previous = node, node = node.next)) return this;
	if (next = node.next) delete node.next;
	if (previous) return next ? previous.next = next : delete previous.next, this;
	if (!parent) return this._root = next, this;
	next ? parent[i] = next : delete parent[i];
	if ((node = parent[0] || parent[1] || parent[2] || parent[3]) && node === (parent[3] || parent[2] || parent[1] || parent[0]) && !node.length) {
		if (retainer) retainer[j] = node;
		else this._root = node;
	}
	return this;
}
function removeAll(data) {
	for (var i = 0, n = data.length; i < n; ++i) this.remove(data[i]);
	return this;
}
//#endregion
//#region node_modules/d3-quadtree/src/root.js
function root_default() {
	return this._root;
}
//#endregion
//#region node_modules/d3-quadtree/src/size.js
function size_default() {
	var size = 0;
	this.visit(function(node) {
		if (!node.length) do
			++size;
		while (node = node.next);
	});
	return size;
}
//#endregion
//#region node_modules/d3-quadtree/src/visit.js
function visit_default(callback) {
	var quads = [], q, node = this._root, child, x0, y0, x1, y1;
	if (node) quads.push(new quad_default(node, this._x0, this._y0, this._x1, this._y1));
	while (q = quads.pop()) if (!callback(node = q.node, x0 = q.x0, y0 = q.y0, x1 = q.x1, y1 = q.y1) && node.length) {
		var xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
		if (child = node[3]) quads.push(new quad_default(child, xm, ym, x1, y1));
		if (child = node[2]) quads.push(new quad_default(child, x0, ym, xm, y1));
		if (child = node[1]) quads.push(new quad_default(child, xm, y0, x1, ym));
		if (child = node[0]) quads.push(new quad_default(child, x0, y0, xm, ym));
	}
	return this;
}
//#endregion
//#region node_modules/d3-quadtree/src/visitAfter.js
function visitAfter_default(callback) {
	var quads = [], next = [], q;
	if (this._root) quads.push(new quad_default(this._root, this._x0, this._y0, this._x1, this._y1));
	while (q = quads.pop()) {
		var node = q.node;
		if (node.length) {
			var child, x0 = q.x0, y0 = q.y0, x1 = q.x1, y1 = q.y1, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
			if (child = node[0]) quads.push(new quad_default(child, x0, y0, xm, ym));
			if (child = node[1]) quads.push(new quad_default(child, xm, y0, x1, ym));
			if (child = node[2]) quads.push(new quad_default(child, x0, ym, xm, y1));
			if (child = node[3]) quads.push(new quad_default(child, xm, ym, x1, y1));
		}
		next.push(q);
	}
	while (q = next.pop()) callback(q.node, q.x0, q.y0, q.x1, q.y1);
	return this;
}
//#endregion
//#region node_modules/d3-quadtree/src/x.js
function defaultX(d) {
	return d[0];
}
function x_default$1(_) {
	return arguments.length ? (this._x = _, this) : this._x;
}
//#endregion
//#region node_modules/d3-quadtree/src/y.js
function defaultY(d) {
	return d[1];
}
function y_default$1(_) {
	return arguments.length ? (this._y = _, this) : this._y;
}
//#endregion
//#region node_modules/d3-quadtree/src/quadtree.js
function quadtree(nodes, x, y) {
	var tree = new Quadtree(x == null ? defaultX : x, y == null ? defaultY : y, NaN, NaN, NaN, NaN);
	return nodes == null ? tree : tree.addAll(nodes);
}
function Quadtree(x, y, x0, y0, x1, y1) {
	this._x = x;
	this._y = y;
	this._x0 = x0;
	this._y0 = y0;
	this._x1 = x1;
	this._y1 = y1;
	this._root = void 0;
}
function leaf_copy(leaf) {
	var copy = { data: leaf.data }, next = copy;
	while (leaf = leaf.next) next = next.next = { data: leaf.data };
	return copy;
}
var treeProto = quadtree.prototype = Quadtree.prototype;
treeProto.copy = function() {
	var copy = new Quadtree(this._x, this._y, this._x0, this._y0, this._x1, this._y1), node = this._root, nodes, child;
	if (!node) return copy;
	if (!node.length) return copy._root = leaf_copy(node), copy;
	nodes = [{
		source: node,
		target: copy._root = new Array(4)
	}];
	while (node = nodes.pop()) for (var i = 0; i < 4; ++i) if (child = node.source[i]) {
		if (child.length) nodes.push({
			source: child,
			target: node.target[i] = new Array(4)
		});
		else node.target[i] = leaf_copy(child);
	}
	return copy;
};
treeProto.add = add_default;
treeProto.addAll = addAll;
treeProto.cover = cover_default;
treeProto.data = data_default;
treeProto.extent = extent_default;
treeProto.find = find_default;
treeProto.remove = remove_default;
treeProto.removeAll = removeAll;
treeProto.root = root_default;
treeProto.size = size_default;
treeProto.visit = visit_default;
treeProto.visitAfter = visitAfter_default;
treeProto.x = x_default$1;
treeProto.y = y_default$1;
//#endregion
//#region node_modules/d3-force/src/constant.js
function constant_default(x) {
	return function() {
		return x;
	};
}
//#endregion
//#region node_modules/d3-force/src/jiggle.js
function jiggle_default(random) {
	return (random() - .5) * 1e-6;
}
//#endregion
//#region node_modules/d3-force/src/collide.js
function x$1(d) {
	return d.x + d.vx;
}
function y$1(d) {
	return d.y + d.vy;
}
function collide_default(radius) {
	var nodes, radii, random, strength = 1, iterations = 1;
	if (typeof radius !== "function") radius = constant_default(radius == null ? 1 : +radius);
	function force() {
		var i, n = nodes.length, tree, node, xi, yi, ri, ri2;
		for (var k = 0; k < iterations; ++k) {
			tree = quadtree(nodes, x$1, y$1).visitAfter(prepare);
			for (i = 0; i < n; ++i) {
				node = nodes[i];
				ri = radii[node.index], ri2 = ri * ri;
				xi = node.x + node.vx;
				yi = node.y + node.vy;
				tree.visit(apply);
			}
		}
		function apply(quad, x0, y0, x1, y1) {
			var data = quad.data, rj = quad.r, r = ri + rj;
			if (data) {
				if (data.index > node.index) {
					var x = xi - data.x - data.vx, y = yi - data.y - data.vy, l = x * x + y * y;
					if (l < r * r) {
						if (x === 0) x = jiggle_default(random), l += x * x;
						if (y === 0) y = jiggle_default(random), l += y * y;
						l = (r - (l = Math.sqrt(l))) / l * strength;
						node.vx += (x *= l) * (r = (rj *= rj) / (ri2 + rj));
						node.vy += (y *= l) * r;
						data.vx -= x * (r = 1 - r);
						data.vy -= y * r;
					}
				}
				return;
			}
			return x0 > xi + r || x1 < xi - r || y0 > yi + r || y1 < yi - r;
		}
	}
	function prepare(quad) {
		if (quad.data) return quad.r = radii[quad.data.index];
		for (var i = quad.r = 0; i < 4; ++i) if (quad[i] && quad[i].r > quad.r) quad.r = quad[i].r;
	}
	function initialize() {
		if (!nodes) return;
		var i, n = nodes.length, node;
		radii = new Array(n);
		for (i = 0; i < n; ++i) node = nodes[i], radii[node.index] = +radius(node, i, nodes);
	}
	force.initialize = function(_nodes, _random) {
		nodes = _nodes;
		random = _random;
		initialize();
	};
	force.iterations = function(_) {
		return arguments.length ? (iterations = +_, force) : iterations;
	};
	force.strength = function(_) {
		return arguments.length ? (strength = +_, force) : strength;
	};
	force.radius = function(_) {
		return arguments.length ? (radius = typeof _ === "function" ? _ : constant_default(+_), initialize(), force) : radius;
	};
	return force;
}
//#endregion
//#region node_modules/d3-force/src/link.js
function index(d) {
	return d.index;
}
function find(nodeById, nodeId) {
	var node = nodeById.get(nodeId);
	if (!node) throw new Error("node not found: " + nodeId);
	return node;
}
function link_default(links) {
	var id = index, strength = defaultStrength, strengths, distance = constant_default(30), distances, nodes, count, bias, random, iterations = 1;
	if (links == null) links = [];
	function defaultStrength(link) {
		return 1 / Math.min(count[link.source.index], count[link.target.index]);
	}
	function force(alpha) {
		for (var k = 0, n = links.length; k < iterations; ++k) for (var i = 0, link, source, target, x, y, l, b; i < n; ++i) {
			link = links[i], source = link.source, target = link.target;
			x = target.x + target.vx - source.x - source.vx || jiggle_default(random);
			y = target.y + target.vy - source.y - source.vy || jiggle_default(random);
			l = Math.sqrt(x * x + y * y);
			l = (l - distances[i]) / l * alpha * strengths[i];
			x *= l, y *= l;
			target.vx -= x * (b = bias[i]);
			target.vy -= y * b;
			source.vx += x * (b = 1 - b);
			source.vy += y * b;
		}
	}
	function initialize() {
		if (!nodes) return;
		var i, n = nodes.length, m = links.length, nodeById = new Map(nodes.map((d, i) => [id(d, i, nodes), d])), link;
		for (i = 0, count = new Array(n); i < m; ++i) {
			link = links[i], link.index = i;
			if (typeof link.source !== "object") link.source = find(nodeById, link.source);
			if (typeof link.target !== "object") link.target = find(nodeById, link.target);
			count[link.source.index] = (count[link.source.index] || 0) + 1;
			count[link.target.index] = (count[link.target.index] || 0) + 1;
		}
		for (i = 0, bias = new Array(m); i < m; ++i) link = links[i], bias[i] = count[link.source.index] / (count[link.source.index] + count[link.target.index]);
		strengths = new Array(m), initializeStrength();
		distances = new Array(m), initializeDistance();
	}
	function initializeStrength() {
		if (!nodes) return;
		for (var i = 0, n = links.length; i < n; ++i) strengths[i] = +strength(links[i], i, links);
	}
	function initializeDistance() {
		if (!nodes) return;
		for (var i = 0, n = links.length; i < n; ++i) distances[i] = +distance(links[i], i, links);
	}
	force.initialize = function(_nodes, _random) {
		nodes = _nodes;
		random = _random;
		initialize();
	};
	force.links = function(_) {
		return arguments.length ? (links = _, initialize(), force) : links;
	};
	force.id = function(_) {
		return arguments.length ? (id = _, force) : id;
	};
	force.iterations = function(_) {
		return arguments.length ? (iterations = +_, force) : iterations;
	};
	force.strength = function(_) {
		return arguments.length ? (strength = typeof _ === "function" ? _ : constant_default(+_), initializeStrength(), force) : strength;
	};
	force.distance = function(_) {
		return arguments.length ? (distance = typeof _ === "function" ? _ : constant_default(+_), initializeDistance(), force) : distance;
	};
	return force;
}
//#endregion
//#region node_modules/d3-dispatch/src/dispatch.js
var noop = { value: () => {} };
function dispatch() {
	for (var i = 0, n = arguments.length, _ = {}, t; i < n; ++i) {
		if (!(t = arguments[i] + "") || t in _ || /[\s.]/.test(t)) throw new Error("illegal type: " + t);
		_[t] = [];
	}
	return new Dispatch(_);
}
function Dispatch(_) {
	this._ = _;
}
function parseTypenames(typenames, types) {
	return typenames.trim().split(/^|\s+/).map(function(t) {
		var name = "", i = t.indexOf(".");
		if (i >= 0) name = t.slice(i + 1), t = t.slice(0, i);
		if (t && !types.hasOwnProperty(t)) throw new Error("unknown type: " + t);
		return {
			type: t,
			name
		};
	});
}
Dispatch.prototype = dispatch.prototype = {
	constructor: Dispatch,
	on: function(typename, callback) {
		var _ = this._, T = parseTypenames(typename + "", _), t, i = -1, n = T.length;
		if (arguments.length < 2) {
			while (++i < n) if ((t = (typename = T[i]).type) && (t = get(_[t], typename.name))) return t;
			return;
		}
		if (callback != null && typeof callback !== "function") throw new Error("invalid callback: " + callback);
		while (++i < n) if (t = (typename = T[i]).type) _[t] = set(_[t], typename.name, callback);
		else if (callback == null) for (t in _) _[t] = set(_[t], typename.name, null);
		return this;
	},
	copy: function() {
		var copy = {}, _ = this._;
		for (var t in _) copy[t] = _[t].slice();
		return new Dispatch(copy);
	},
	call: function(type, that) {
		if ((n = arguments.length - 2) > 0) for (var args = new Array(n), i = 0, n, t; i < n; ++i) args[i] = arguments[i + 2];
		if (!this._.hasOwnProperty(type)) throw new Error("unknown type: " + type);
		for (t = this._[type], i = 0, n = t.length; i < n; ++i) t[i].value.apply(that, args);
	},
	apply: function(type, that, args) {
		if (!this._.hasOwnProperty(type)) throw new Error("unknown type: " + type);
		for (var t = this._[type], i = 0, n = t.length; i < n; ++i) t[i].value.apply(that, args);
	}
};
function get(type, name) {
	for (var i = 0, n = type.length, c; i < n; ++i) if ((c = type[i]).name === name) return c.value;
}
function set(type, name, callback) {
	for (var i = 0, n = type.length; i < n; ++i) if (type[i].name === name) {
		type[i] = noop, type = type.slice(0, i).concat(type.slice(i + 1));
		break;
	}
	if (callback != null) type.push({
		name,
		value: callback
	});
	return type;
}
//#endregion
//#region node_modules/d3-timer/src/timer.js
var frame = 0;
var timeout = 0;
var interval = 0;
var pokeDelay = 1e3;
var taskHead;
var taskTail;
var clockLast = 0;
var clockNow = 0;
var clockSkew = 0;
var clock = typeof performance === "object" && performance.now ? performance : Date;
var setFrame = typeof window === "object" && window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function(f) {
	setTimeout(f, 17);
};
function now() {
	return clockNow || (setFrame(clearNow), clockNow = clock.now() + clockSkew);
}
function clearNow() {
	clockNow = 0;
}
function Timer() {
	this._call = this._time = this._next = null;
}
Timer.prototype = timer.prototype = {
	constructor: Timer,
	restart: function(callback, delay, time) {
		if (typeof callback !== "function") throw new TypeError("callback is not a function");
		time = (time == null ? now() : +time) + (delay == null ? 0 : +delay);
		if (!this._next && taskTail !== this) {
			if (taskTail) taskTail._next = this;
			else taskHead = this;
			taskTail = this;
		}
		this._call = callback;
		this._time = time;
		sleep();
	},
	stop: function() {
		if (this._call) {
			this._call = null;
			this._time = Infinity;
			sleep();
		}
	}
};
function timer(callback, delay, time) {
	var t = new Timer();
	t.restart(callback, delay, time);
	return t;
}
function timerFlush() {
	now();
	++frame;
	var t = taskHead, e;
	while (t) {
		if ((e = clockNow - t._time) >= 0) t._call.call(void 0, e);
		t = t._next;
	}
	--frame;
}
function wake() {
	clockNow = (clockLast = clock.now()) + clockSkew;
	frame = timeout = 0;
	try {
		timerFlush();
	} finally {
		frame = 0;
		nap();
		clockNow = 0;
	}
}
function poke() {
	var now = clock.now(), delay = now - clockLast;
	if (delay > pokeDelay) clockSkew -= delay, clockLast = now;
}
function nap() {
	var t0, t1 = taskHead, t2, time = Infinity;
	while (t1) if (t1._call) {
		if (time > t1._time) time = t1._time;
		t0 = t1, t1 = t1._next;
	} else {
		t2 = t1._next, t1._next = null;
		t1 = t0 ? t0._next = t2 : taskHead = t2;
	}
	taskTail = t0;
	sleep(time);
}
function sleep(time) {
	if (frame) return;
	if (timeout) timeout = clearTimeout(timeout);
	if (time - clockNow > 24) {
		if (time < Infinity) timeout = setTimeout(wake, time - clock.now() - clockSkew);
		if (interval) interval = clearInterval(interval);
	} else {
		if (!interval) clockLast = clock.now(), interval = setInterval(poke, pokeDelay);
		frame = 1, setFrame(wake);
	}
}
//#endregion
//#region node_modules/d3-force/src/lcg.js
const a = 1664525;
const c = 1013904223;
const m = 4294967296;
function lcg_default() {
	let s = 1;
	return () => (s = (a * s + c) % m) / m;
}
//#endregion
//#region node_modules/d3-force/src/simulation.js
function x(d) {
	return d.x;
}
function y(d) {
	return d.y;
}
var initialRadius = 10;
var initialAngle = Math.PI * (3 - Math.sqrt(5));
function simulation_default(nodes) {
	var simulation, alpha = 1, alphaMin = .001, alphaDecay = 1 - Math.pow(alphaMin, 1 / 300), alphaTarget = 0, velocityDecay = .6, forces = /* @__PURE__ */ new Map(), stepper = timer(step), event = dispatch("tick", "end"), random = lcg_default();
	if (nodes == null) nodes = [];
	function step() {
		tick();
		event.call("tick", simulation);
		if (alpha < alphaMin) {
			stepper.stop();
			event.call("end", simulation);
		}
	}
	function tick(iterations) {
		var i, n = nodes.length, node;
		if (iterations === void 0) iterations = 1;
		for (var k = 0; k < iterations; ++k) {
			alpha += (alphaTarget - alpha) * alphaDecay;
			forces.forEach(function(force) {
				force(alpha);
			});
			for (i = 0; i < n; ++i) {
				node = nodes[i];
				if (node.fx == null) node.x += node.vx *= velocityDecay;
				else node.x = node.fx, node.vx = 0;
				if (node.fy == null) node.y += node.vy *= velocityDecay;
				else node.y = node.fy, node.vy = 0;
			}
		}
		return simulation;
	}
	function initializeNodes() {
		for (var i = 0, n = nodes.length, node; i < n; ++i) {
			node = nodes[i], node.index = i;
			if (node.fx != null) node.x = node.fx;
			if (node.fy != null) node.y = node.fy;
			if (isNaN(node.x) || isNaN(node.y)) {
				var radius = initialRadius * Math.sqrt(.5 + i), angle = i * initialAngle;
				node.x = radius * Math.cos(angle);
				node.y = radius * Math.sin(angle);
			}
			if (isNaN(node.vx) || isNaN(node.vy)) node.vx = node.vy = 0;
		}
	}
	function initializeForce(force) {
		if (force.initialize) force.initialize(nodes, random);
		return force;
	}
	initializeNodes();
	return simulation = {
		tick,
		restart: function() {
			return stepper.restart(step), simulation;
		},
		stop: function() {
			return stepper.stop(), simulation;
		},
		nodes: function(_) {
			return arguments.length ? (nodes = _, initializeNodes(), forces.forEach(initializeForce), simulation) : nodes;
		},
		alpha: function(_) {
			return arguments.length ? (alpha = +_, simulation) : alpha;
		},
		alphaMin: function(_) {
			return arguments.length ? (alphaMin = +_, simulation) : alphaMin;
		},
		alphaDecay: function(_) {
			return arguments.length ? (alphaDecay = +_, simulation) : +alphaDecay;
		},
		alphaTarget: function(_) {
			return arguments.length ? (alphaTarget = +_, simulation) : alphaTarget;
		},
		velocityDecay: function(_) {
			return arguments.length ? (velocityDecay = 1 - _, simulation) : 1 - velocityDecay;
		},
		randomSource: function(_) {
			return arguments.length ? (random = _, forces.forEach(initializeForce), simulation) : random;
		},
		force: function(name, _) {
			return arguments.length > 1 ? (_ == null ? forces.delete(name) : forces.set(name, initializeForce(_)), simulation) : forces.get(name);
		},
		find: function(x, y, radius) {
			var i = 0, n = nodes.length, dx, dy, d2, node, closest;
			if (radius == null) radius = Infinity;
			else radius *= radius;
			for (i = 0; i < n; ++i) {
				node = nodes[i];
				dx = x - node.x;
				dy = y - node.y;
				d2 = dx * dx + dy * dy;
				if (d2 < radius) closest = node, radius = d2;
			}
			return closest;
		},
		on: function(name, _) {
			return arguments.length > 1 ? (event.on(name, _), simulation) : event.on(name);
		}
	};
}
//#endregion
//#region node_modules/d3-force/src/manyBody.js
function manyBody_default() {
	var nodes, node, random, alpha, strength = constant_default(-30), strengths, distanceMin2 = 1, distanceMax2 = Infinity, theta2 = .81;
	function force(_) {
		var i, n = nodes.length, tree = quadtree(nodes, x, y).visitAfter(accumulate);
		for (alpha = _, i = 0; i < n; ++i) node = nodes[i], tree.visit(apply);
	}
	function initialize() {
		if (!nodes) return;
		var i, n = nodes.length, node;
		strengths = new Array(n);
		for (i = 0; i < n; ++i) node = nodes[i], strengths[node.index] = +strength(node, i, nodes);
	}
	function accumulate(quad) {
		var strength = 0, q, c, weight = 0, x, y, i;
		if (quad.length) {
			for (x = y = i = 0; i < 4; ++i) if ((q = quad[i]) && (c = Math.abs(q.value))) strength += q.value, weight += c, x += c * q.x, y += c * q.y;
			quad.x = x / weight;
			quad.y = y / weight;
		} else {
			q = quad;
			q.x = q.data.x;
			q.y = q.data.y;
			do
				strength += strengths[q.data.index];
			while (q = q.next);
		}
		quad.value = strength;
	}
	function apply(quad, x1, _, x2) {
		if (!quad.value) return true;
		var x = quad.x - node.x, y = quad.y - node.y, w = x2 - x1, l = x * x + y * y;
		if (w * w / theta2 < l) {
			if (l < distanceMax2) {
				if (x === 0) x = jiggle_default(random), l += x * x;
				if (y === 0) y = jiggle_default(random), l += y * y;
				if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
				node.vx += x * quad.value * alpha / l;
				node.vy += y * quad.value * alpha / l;
			}
			return true;
		} else if (quad.length || l >= distanceMax2) return;
		if (quad.data !== node || quad.next) {
			if (x === 0) x = jiggle_default(random), l += x * x;
			if (y === 0) y = jiggle_default(random), l += y * y;
			if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
		}
		do
			if (quad.data !== node) {
				w = strengths[quad.data.index] * alpha / l;
				node.vx += x * w;
				node.vy += y * w;
			}
		while (quad = quad.next);
	}
	force.initialize = function(_nodes, _random) {
		nodes = _nodes;
		random = _random;
		initialize();
	};
	force.strength = function(_) {
		return arguments.length ? (strength = typeof _ === "function" ? _ : constant_default(+_), initialize(), force) : strength;
	};
	force.distanceMin = function(_) {
		return arguments.length ? (distanceMin2 = _ * _, force) : Math.sqrt(distanceMin2);
	};
	force.distanceMax = function(_) {
		return arguments.length ? (distanceMax2 = _ * _, force) : Math.sqrt(distanceMax2);
	};
	force.theta = function(_) {
		return arguments.length ? (theta2 = _ * _, force) : Math.sqrt(theta2);
	};
	return force;
}
//#endregion
//#region node_modules/d3-force/src/x.js
function x_default(x) {
	var strength = constant_default(.1), nodes, strengths, xz;
	if (typeof x !== "function") x = constant_default(x == null ? 0 : +x);
	function force(alpha) {
		for (var i = 0, n = nodes.length, node; i < n; ++i) node = nodes[i], node.vx += (xz[i] - node.x) * strengths[i] * alpha;
	}
	function initialize() {
		if (!nodes) return;
		var i, n = nodes.length;
		strengths = new Array(n);
		xz = new Array(n);
		for (i = 0; i < n; ++i) strengths[i] = isNaN(xz[i] = +x(nodes[i], i, nodes)) ? 0 : +strength(nodes[i], i, nodes);
	}
	force.initialize = function(_) {
		nodes = _;
		initialize();
	};
	force.strength = function(_) {
		return arguments.length ? (strength = typeof _ === "function" ? _ : constant_default(+_), initialize(), force) : strength;
	};
	force.x = function(_) {
		return arguments.length ? (x = typeof _ === "function" ? _ : constant_default(+_), initialize(), force) : x;
	};
	return force;
}
//#endregion
//#region node_modules/d3-force/src/y.js
function y_default(y) {
	var strength = constant_default(.1), nodes, strengths, yz;
	if (typeof y !== "function") y = constant_default(y == null ? 0 : +y);
	function force(alpha) {
		for (var i = 0, n = nodes.length, node; i < n; ++i) node = nodes[i], node.vy += (yz[i] - node.y) * strengths[i] * alpha;
	}
	function initialize() {
		if (!nodes) return;
		var i, n = nodes.length;
		strengths = new Array(n);
		yz = new Array(n);
		for (i = 0; i < n; ++i) strengths[i] = isNaN(yz[i] = +y(nodes[i], i, nodes)) ? 0 : +strength(nodes[i], i, nodes);
	}
	force.initialize = function(_) {
		nodes = _;
		initialize();
	};
	force.strength = function(_) {
		return arguments.length ? (strength = typeof _ === "function" ? _ : constant_default(+_), initialize(), force) : strength;
	};
	force.y = function(_) {
		return arguments.length ? (y = typeof _ === "function" ? _ : constant_default(+_), initialize(), force) : y;
	};
	return force;
}
//#endregion
//#region src/renderer.ts
const MIN_ZOOM = .03;
const MAX_ZOOM = 8;
const CLICK_SLOP = 4;
/** Parses `rgb(…)` / `rgba(…)` / `#rrggbb` into components. */
function parseColor(c) {
	const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
	if (m) return [
		Number(m[1]),
		Number(m[2]),
		Number(m[3])
	];
	const h = /^#([0-9a-f]{6})$/i.exec(c.trim());
	if (h) return [
		0,
		2,
		4
	].map((i) => parseInt(h[1].slice(i, i + 2), 16));
	return null;
}
function withAlpha(c, a) {
	const p = parseColor(c);
	return p ? `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${a})` : c;
}
/** Convex hull (monotone chain), counter-clockwise. */
function convexHull(points) {
	if (points.length < 3) return points.slice();
	const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
		lower.push(p);
	}
	const upper = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
		upper.push(p);
	}
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}
/** Region-center key for the notes in no region */
const OTHERS = "\0others";
/**
* Draws a force-directed graph on a canvas, Obsidian-style: grey nodes sized
* by their link count, labels that fade in as you zoom, and hover highlighting
* of a node's neighbors.
*/
var GraphRenderer = class {
	canvas;
	callbacks;
	ctx;
	sim;
	nodes = [];
	links = [];
	regions = [];
	/** World position each region's notes are pulled toward */
	regionCenters = /* @__PURE__ */ new Map();
	byId = /* @__PURE__ */ new Map();
	neighbors = /* @__PURE__ */ new Map();
	settings;
	colors;
	width = 0;
	height = 0;
	dpr = 1;
	/** View transform: screen = world * k + (x, y) */
	t = {
		x: 0,
		y: 0,
		k: 1
	};
	pointer = { mode: "idle" };
	hover = null;
	focusId = null;
	frame = 0;
	fitPending = true;
	ticksSinceData = 0;
	/** Animate: only nodes created before this are drawn */
	revealUntil = null;
	revealTimer = null;
	outlines = [];
	resizeObserver;
	disposed = false;
	constructor(canvas, callbacks) {
		this.canvas = canvas;
		this.callbacks = callbacks;
		this.ctx = canvas.getContext("2d");
		this.sim = simulation_default().force("link", link_default().id((d) => d.id)).force("charge", manyBody_default().theta(.5).distanceMax(2e3)).force("x", x_default(0)).force("y", y_default(0)).force("collide", collide_default((d) => this.radius(d) + 2).strength(.3)).alphaDecay(.02).velocityDecay(.4).on("tick", () => {
			if (this.fitPending) {
				this.ticksSinceData++;
				if (this.ticksSinceData === 30) this.fit(false);
				if (this.sim.alpha() < .08) {
					this.fitPending = false;
					this.fit();
				}
			}
			this.requestDraw();
		}).stop();
		this.readColors();
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(canvas.parentElement ?? canvas);
		this.resize();
		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);
		canvas.addEventListener("dblclick", this.onDoubleClick);
	}
	dispose() {
		this.disposed = true;
		this.sim.stop();
		this.sim.on("tick", null);
		if (this.revealTimer) clearInterval(this.revealTimer);
		cancelAnimationFrame(this.frame);
		this.resizeObserver.disconnect();
		const c = this.canvas;
		c.removeEventListener("wheel", this.onWheel);
		c.removeEventListener("pointerdown", this.onPointerDown);
		c.removeEventListener("pointermove", this.onPointerMove);
		c.removeEventListener("pointerup", this.onPointerUp);
		c.removeEventListener("pointerleave", this.onPointerLeave);
		c.removeEventListener("dblclick", this.onDoubleClick);
	}
	/** Theme colors, from the CSS of the canvas's container. */
	readColors() {
		const host = this.canvas.parentElement ?? this.canvas;
		const cs = getComputedStyle(host);
		const text = cs.color || "#888";
		const accent = cs.getPropertyValue("--graph-accent").trim() || cs.getPropertyValue("--primary-color").trim() || "#8a5cf5";
		this.colors = {
			background: cs.backgroundColor,
			text,
			node: withAlpha(text, .55),
			tag: "#57ab5a",
			link: withAlpha(text, .22),
			accent
		};
		this.requestDraw();
	}
	setSettings(settings) {
		const prev = this.settings;
		this.settings = settings;
		this.sim.force("link").distance(settings.linkDistance * .3).strength((l) => {
			const s = l.source;
			const t = l.target;
			const across = this.regions.length && s.region !== t.region ? 1 - settings.regionForce * .95 : 1;
			return settings.linkForce * across / Math.max(1, Math.min(s.degree || 1, t.degree || 1));
		});
		this.sim.force("charge").strength(-settings.repelForce * 25);
		this.layoutRegions();
		const target = (d) => this.regionCenters.get(d.region ?? (d.kind === "note" ? OTHERS : ""));
		const pull = (d) => settings.centerForce * .12 + (target(d) && settings.regionForce ? .03 + settings.regionForce * .3 : 0);
		this.sim.force("x").x((d) => target(d)?.x ?? 0).strength(pull);
		this.sim.force("y").y((d) => target(d)?.y ?? 0).strength(pull);
		this.sim.force("collide").radius((d) => this.radius(d) + 2);
		if ((!prev || prev.linkDistance !== settings.linkDistance || prev.linkForce !== settings.linkForce || prev.repelForce !== settings.repelForce || prev.centerForce !== settings.centerForce || prev.regionForce !== settings.regionForce || prev.nodeSize !== settings.nodeSize) && this.nodes.length) this.sim.alpha(Math.max(this.sim.alpha(), .3)).restart();
		this.requestDraw();
	}
	/** The note to ring (the open note / local graph center). */
	setFocus(id) {
		this.focusId = id;
		this.requestDraw();
	}
	setData(data) {
		const old = this.byId;
		const isFirst = this.nodes.length === 0;
		const nodes = data.nodes.map((n) => {
			const prev = old.get(n.id);
			return prev ? Object.assign(prev, {
				...n,
				x: prev.x,
				y: prev.y,
				vx: prev.vx,
				vy: prev.vy
			}) : { ...n };
		});
		this.byId = new Map(nodes.map((n) => [n.id, n]));
		this.neighbors = /* @__PURE__ */ new Map();
		for (const l of data.links) {
			const s = typeof l.source === "string" ? l.source : l.source.id;
			const t = typeof l.target === "string" ? l.target : l.target.id;
			if (!this.neighbors.has(s)) this.neighbors.set(s, /* @__PURE__ */ new Set());
			if (!this.neighbors.has(t)) this.neighbors.set(t, /* @__PURE__ */ new Set());
			this.neighbors.get(s).add(t);
			this.neighbors.get(t).add(s);
		}
		let added = 0;
		for (const n of nodes) {
			if (n.x !== void 0 || isFirst) continue;
			added++;
			const anchor = [...this.neighbors.get(n.id) ?? []].map((id) => this.byId.get(id)).find((m) => m?.x !== void 0);
			n.x = (anchor?.x ?? 0) + (Math.random() - .5) * 30;
			n.y = (anchor?.y ?? 0) + (Math.random() - .5) * 30;
		}
		this.nodes = nodes;
		this.links = data.links.map((l) => ({ ...l }));
		const regionsChanged = this.regions.length !== data.regions.length || this.regions.some((r, i) => r.id !== data.regions[i].id);
		this.regions = data.regions;
		if (!isFirst && regionsChanged) {
			this.sim.alpha(Math.max(this.sim.alpha(), .6));
			this.fitPending = true;
			this.ticksSinceData = 30;
		}
		if (this.hover && !this.byId.has(this.hover.id)) this.setHover(null);
		if (isFirst && this.regions.length && this.settings) {
			this.layoutRegions();
			for (const n of this.nodes) {
				const c = this.regionCenters.get(n.region ?? (n.kind === "note" ? OTHERS : ""));
				if (!c) continue;
				const a = Math.random() * Math.PI * 2;
				const d = Math.sqrt(Math.random()) * c.r * .8;
				n.x = c.x + Math.cos(a) * d;
				n.y = c.y + Math.sin(a) * d;
			}
		}
		this.sim.nodes(this.nodes);
		this.sim.force("link").links(this.links);
		if (this.settings) this.setSettings(this.settings);
		if (isFirst) {
			this.fitPending = true;
			this.ticksSinceData = 0;
			this.sim.alpha(1).restart();
		} else if (added || old.size !== nodes.length) this.sim.alpha(Math.max(this.sim.alpha(), .3)).restart();
		else this.sim.alpha(Math.max(this.sim.alpha(), .05)).restart();
		this.requestDraw();
	}
	/** Replays the graph growing in the order notes were created. */
	animate() {
		if (this.revealTimer) clearInterval(this.revealTimer);
		const order = this.nodes.filter((n) => n.kind === "note").map((n) => n.createdAt).sort((a, b) => a - b);
		if (!order.length) return;
		for (const n of this.nodes) {
			n.x = (Math.random() - .5) * 50;
			n.y = (Math.random() - .5) * 50;
			n.vx = n.vy = 0;
		}
		const steps = Math.min(order.length, 200);
		let step = 0;
		this.revealUntil = order[0];
		this.sim.alpha(1).restart();
		this.revealTimer = setInterval(() => {
			step++;
			if (step >= steps) {
				this.revealUntil = null;
				clearInterval(this.revealTimer);
				this.revealTimer = null;
			} else this.revealUntil = order[Math.floor((order.length - 1) * (step / steps))];
			this.sim.alpha(Math.max(this.sim.alpha(), .5));
			this.requestDraw();
		}, 40);
	}
	/** Zooms to show every node (or centers the focused node in a local graph). */
	fit(animated = true) {
		const pts = this.nodes.filter((n) => n.x !== void 0);
		if (!pts.length || !this.width) return;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const n of pts) {
			const r = this.radius(n);
			x0 = Math.min(x0, n.x - r);
			y0 = Math.min(y0, n.y - r);
			x1 = Math.max(x1, n.x + r);
			y1 = Math.max(y1, n.y + r);
		}
		const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((this.width - 80) / (x1 - x0 || 1), (this.height - 80) / (y1 - y0 || 1))));
		const target = {
			k: Math.min(k, 2),
			x: this.width / 2 - (x0 + x1) / 2 * Math.min(k, 2),
			y: this.height / 2 - (y0 + y1) / 2 * Math.min(k, 2)
		};
		if (!animated) {
			this.t = target;
			this.requestDraw();
			return;
		}
		const from = { ...this.t };
		const start = performance.now();
		const step = (now) => {
			if (this.disposed) return;
			const p = Math.min(1, (now - start) / 300);
			const e = 1 - Math.pow(1 - p, 3);
			this.t = {
				x: from.x + (target.x - from.x) * e,
				y: from.y + (target.y - from.y) * e,
				k: from.k + (target.k - from.k) * e
			};
			this.draw();
			if (p < 1) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}
	zoomBy(factor) {
		this.zoomAt(this.width / 2, this.height / 2, factor);
	}
	/**
	* Region centers, packed without overlap: each region is a circle sized by
	* its note count, placed biggest first at the free spot nearest the middle.
	* The notes in no region get a spot of their own too.
	*/
	layoutRegions() {
		this.regionCenters = /* @__PURE__ */ new Map();
		if (!this.regions.length || !this.settings) return;
		const spread = Math.sqrt(Math.max(1, this.settings.repelForce) / 10) * (this.settings.nodeSize ?? 1);
		const radius = (size) => (30 + Math.sqrt(size) * 20) * spread;
		const others = this.nodes.filter((n) => n.kind === "note" && !n.region).length;
		const items = [...this.regions.map((r) => ({
			id: r.id,
			size: r.size
		})), ...others ? [{
			id: OTHERS,
			size: others
		}] : []].sort((a, b) => b.size - a.size);
		const placed = [];
		const gap = 40 * spread;
		for (const item of items) {
			const r = radius(item.size);
			let x = 0;
			let y = 0;
			for (let step = 0; placed.length && step < 2e4; step++) {
				const a = step * .25;
				const d = step * 3 * spread;
				x = Math.cos(a) * d;
				y = Math.sin(a) * d;
				if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + gap)) break;
			}
			placed.push({
				x,
				y,
				r
			});
			this.regionCenters.set(item.id, {
				x,
				y,
				r
			});
		}
	}
	radius(n) {
		return ((n.kind === "tag" ? 3 : 4) + Math.min(Math.sqrt(n.degree) * 1.8, 22)) * (this.settings?.nodeSize ?? 1);
	}
	toWorld(sx, sy) {
		return {
			x: (sx - this.t.x) / this.t.k,
			y: (sy - this.t.y) / this.t.k
		};
	}
	nodeAt(sx, sy) {
		const { x, y } = this.toWorld(sx, sy);
		let best = null;
		let bestD = Infinity;
		for (const n of this.nodes) {
			if (!this.isRevealed(n)) continue;
			const r = this.radius(n) + 4 / this.t.k;
			const d = (n.x - x) ** 2 + (n.y - y) ** 2;
			if (d <= r * r && d < bestD) {
				best = n;
				bestD = d;
			}
		}
		return best;
	}
	isRevealed(n) {
		return this.revealUntil === null || n.kind === "tag" || n.createdAt <= this.revealUntil;
	}
	zoomAt(sx, sy, factor) {
		const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.t.k * factor));
		const w = this.toWorld(sx, sy);
		this.t = {
			k,
			x: sx - w.x * k,
			y: sy - w.y * k
		};
		this.requestDraw();
	}
	resize() {
		const rect = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		if (!!this.width) {
			this.t.x += (rect.width - this.width) / 2;
			this.t.y += (rect.height - this.height) / 2;
		} else this.t = {
			x: rect.width / 2,
			y: rect.height / 2,
			k: 1
		};
		this.width = rect.width;
		this.height = rect.height;
		this.dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.round(rect.width * this.dpr);
		this.canvas.height = Math.round(rect.height * this.dpr);
		this.canvas.style.width = `${rect.width}px`;
		this.canvas.style.height = `${rect.height}px`;
		this.draw();
	}
	local(e) {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top
		};
	}
	onWheel = (e) => {
		e.preventDefault();
		const p = this.local(e);
		const speed = e.ctrlKey ? .01 : .0015;
		this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * speed));
	};
	onPointerDown = (e) => {
		if (e.button !== 0) return;
		const p = this.local(e);
		const node = this.nodeAt(p.x, p.y);
		this.canvas.setPointerCapture(e.pointerId);
		if (node) this.pointer = {
			mode: "node",
			node,
			startX: p.x,
			startY: p.y,
			moved: false
		};
		else {
			this.pointer = {
				mode: "pan",
				startX: p.x,
				startY: p.y,
				tx: this.t.x,
				ty: this.t.y,
				moved: false
			};
			this.canvas.classList.add("panning");
		}
	};
	onPointerMove = (e) => {
		const p = this.local(e);
		const ptr = this.pointer;
		if (ptr.mode === "pan") {
			if (!ptr.moved && Math.hypot(p.x - ptr.startX, p.y - ptr.startY) < CLICK_SLOP) return;
			ptr.moved = true;
			this.t.x = ptr.tx + (p.x - ptr.startX);
			this.t.y = ptr.ty + (p.y - ptr.startY);
			this.requestDraw();
			return;
		}
		if (ptr.mode === "node") {
			if (!ptr.moved && Math.hypot(p.x - ptr.startX, p.y - ptr.startY) < CLICK_SLOP) return;
			if (!ptr.moved) {
				ptr.moved = true;
				this.sim.alphaTarget(.3).restart();
			}
			const w = this.toWorld(p.x, p.y);
			ptr.node.fx = w.x;
			ptr.node.fy = w.y;
			return;
		}
		const node = this.nodeAt(p.x, p.y);
		if (node !== this.hover) this.setHover(node);
	};
	onPointerUp = (e) => {
		const ptr = this.pointer;
		this.pointer = { mode: "idle" };
		this.canvas.classList.remove("panning");
		if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
		if (ptr.mode !== "node") return;
		if (ptr.moved) {
			ptr.node.fx = null;
			ptr.node.fy = null;
			this.sim.alphaTarget(0);
			return;
		}
		this.callbacks.onOpen(ptr.node, {
			metaKey: e.metaKey || e.ctrlKey,
			shiftKey: e.shiftKey
		});
	};
	onPointerLeave = () => {
		if (this.pointer.mode === "idle") this.setHover(null);
	};
	onDoubleClick = (e) => {
		const p = this.local(e);
		if (!this.nodeAt(p.x, p.y)) this.zoomAt(p.x, p.y, 1.6);
	};
	setHover(node) {
		this.hover = node;
		this.canvas.style.cursor = node ? "pointer" : "";
		this.callbacks.onHover(node);
		this.requestDraw();
	}
	requestDraw() {
		if (this.frame || this.disposed) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.draw();
		});
	}
	labelAlpha() {
		const threshold = 1.1 * Math.pow(2, (this.settings?.textFade ?? 0) / 1.5);
		return Math.max(0, Math.min(1, (this.t.k - threshold * .6) / (threshold * .5)));
	}
	draw() {
		if (this.disposed || !this.width || !this.settings) return;
		const { ctx, colors, settings } = this;
		const { k } = this.t;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.clearRect(0, 0, this.width, this.height);
		ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * this.t.x, this.dpr * this.t.y);
		const hover = this.hover;
		const lit = hover ? /* @__PURE__ */ new Set([hover.id, ...this.neighbors.get(hover.id) ?? []]) : null;
		const dim = (id) => !!lit && !lit.has(id);
		if (settings.showRegions && this.regions.length) this.drawRegions(!!lit);
		const linkWidth = settings.linkThickness * 1 / Math.max(k, .35);
		for (const l of this.links) {
			const s = l.source;
			const t = l.target;
			if (!this.isRevealed(s) || !this.isRevealed(t)) continue;
			const active = !!hover && (s.id === hover.id || t.id === hover.id);
			ctx.strokeStyle = active ? colors.accent : lit ? withAlpha(colors.text, .06) : colors.link;
			ctx.lineWidth = active ? linkWidth * 1.8 : linkWidth;
			ctx.beginPath();
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(t.x, t.y);
			ctx.stroke();
			if (settings.arrows) this.drawArrow(s, t, active ? colors.accent : ctx.strokeStyle, linkWidth);
		}
		for (const n of this.nodes) {
			if (!this.isRevealed(n)) continue;
			const r = this.radius(n);
			let fill = n.color ?? (n.kind === "tag" ? colors.tag : colors.node);
			if (hover && n.id === hover.id) fill = colors.accent;
			ctx.globalAlpha = dim(n.id) ? .2 : 1;
			ctx.fillStyle = fill;
			ctx.beginPath();
			ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
			ctx.fill();
			if (n.id === this.focusId) {
				ctx.strokeStyle = colors.accent;
				ctx.lineWidth = Math.max(2, 2.5 / k);
				ctx.beginPath();
				ctx.arc(n.x, n.y, r + Math.max(2, 3 / k), 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		ctx.globalAlpha = 1;
		const base = this.labelAlpha();
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (const n of this.nodes) {
			if (!this.isRevealed(n)) continue;
			const always = lit && lit.has(n.id) || n.id === this.focusId;
			let a = always ? 1 : base;
			if (lit && !lit.has(n.id)) a *= .2;
			if (a <= .02) continue;
			ctx.font = `${always && k < 1 ? 12 / k : 12}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`;
			ctx.globalAlpha = a;
			ctx.fillStyle = colors.text;
			const label = n.label.length > 40 ? `${n.label.slice(0, 39)}…` : n.label;
			ctx.fillText(label, n.x, n.y + this.radius(n) + 4);
		}
		ctx.globalAlpha = 1;
		if (settings.showRegions && this.regions.length) this.drawRegionLabels(!!lit);
	}
	/** Each region's outline: its notes' hull, padded and rounded. */
	regionOutlines() {
		const members = /* @__PURE__ */ new Map();
		for (const n of this.nodes) {
			if (n.x === void 0 || !this.isRevealed(n) || !n.region && n.kind !== "note") continue;
			const key = n.region ?? OTHERS;
			const list = members.get(key);
			const p = [n.x, n.y];
			if (list) list.push(p);
			else members.set(key, [p]);
		}
		const others = {
			id: OTHERS,
			label: "その他",
			color: this.colors.text,
			size: members.get(OTHERS)?.length ?? 0
		};
		const pad = 26 * (this.settings.nodeSize ?? 1);
		const out = [];
		for (const region of [...this.regions, others]) {
			const all = members.get(region.id);
			if (!all) continue;
			const cx = all.reduce((sum, p) => sum + p[0], 0) / all.length;
			const cy = all.reduce((sum, p) => sum + p[1], 0) / all.length;
			const dist = all.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
			const median = dist.slice().sort((a, b) => a - b)[Math.floor(dist.length / 2)];
			const limit = Math.max(median * 2.2, pad * 3);
			const pts = all.filter((_, i) => dist[i] <= limit);
			const ring = [];
			for (const [x, y] of convexHull(pts)) for (let i = 0; i < 12; i++) {
				const a = i / 12 * Math.PI * 2;
				ring.push([x + Math.cos(a) * pad, y + Math.sin(a) * pad]);
			}
			out.push({
				region,
				hull: convexHull(ring)
			});
		}
		return out;
	}
	drawRegions(dimmed) {
		const { ctx } = this;
		this.outlines = this.regionOutlines();
		for (const { region, hull } of this.outlines) {
			if (hull.length < 3) continue;
			ctx.beginPath();
			const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
			const start = mid(hull[hull.length - 1], hull[0]);
			ctx.moveTo(start[0], start[1]);
			for (let i = 0; i < hull.length; i++) {
				const m = mid(hull[i], hull[(i + 1) % hull.length]);
				ctx.quadraticCurveTo(hull[i][0], hull[i][1], m[0], m[1]);
			}
			ctx.closePath();
			const isOthers = region.id === OTHERS;
			if (!isOthers) {
				ctx.fillStyle = withAlpha(region.color, dimmed ? .03 : .08);
				ctx.fill();
			}
			ctx.setLineDash(isOthers ? [6 / this.t.k, 6 / this.t.k] : []);
			ctx.strokeStyle = withAlpha(region.color, isOthers ? .15 : dimmed ? .12 : .4);
			ctx.lineWidth = 1.5 / this.t.k;
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}
	/** Region names above their outlines, at a fixed size on screen. */
	drawRegionLabels(dimmed) {
		const { ctx } = this;
		const k = this.t.k;
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		for (const { region, hull } of this.outlines) {
			if (!hull.length) continue;
			let top = Infinity;
			let x0 = Infinity;
			let x1 = -Infinity;
			for (const [x, y] of hull) {
				top = Math.min(top, y);
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x);
			}
			ctx.font = `600 ${15 / k}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`;
			ctx.globalAlpha = (dimmed ? .3 : 1) * (region.id === OTHERS ? .45 : 1);
			ctx.fillStyle = region.color;
			ctx.fillText(`${region.label}  ${region.size}`, (x0 + x1) / 2, top - 4 / k);
		}
		ctx.globalAlpha = 1;
	}
	drawArrow(s, t, color, width) {
		const { ctx } = this;
		const dx = t.x - s.x;
		const dy = t.y - s.y;
		const len = Math.hypot(dx, dy);
		if (len < 1) return;
		const ux = dx / len;
		const uy = dy / len;
		const r = this.radius(t);
		const tipX = t.x - ux * (r + 1);
		const tipY = t.y - uy * (r + 1);
		const size = Math.max(4, width * 4);
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(tipX, tipY);
		ctx.lineTo(tipX - ux * size - uy * size * .5, tipY - uy * size + ux * size * .5);
		ctx.lineTo(tipX - ux * size + uy * size * .5, tipY - uy * size - ux * size * .5);
		ctx.closePath();
		ctx.fill();
	}
};
//#endregion
//#region src/graph-pane.tsx
/** Re-renders whenever the note index changes (or finishes loading). */
function useIndexVersion() {
	const [version, setVersion] = (0, react.useState)(() => getIndex()?.version ?? 0);
	(0, react.useEffect)(() => {
		let sub = null;
		let timer = null;
		const attach = () => {
			const index = getIndex();
			if (!index) {
				timer = setTimeout(attach, 300);
				return;
			}
			sub = index.onDidChange(() => setVersion(index.version));
			setVersion(index.version);
		};
		attach();
		return () => {
			if (timer) clearTimeout(timer);
			sub?.dispose();
		};
	}, []);
	return version;
}
function queryContext() {
	return {
		books: getEnv().store.getState().books?.hash ?? {},
		tags: getIndex()?.tags ?? /* @__PURE__ */ new Map()
	};
}
const GraphPane = ({ kind, center = null, focus = null, onWillOpen, toolbar }) => {
	const canvasRef = (0, react.useRef)(null);
	const rendererRef = (0, react.useRef)(null);
	const [settings, setSettings] = (0, react.useState)(() => loadSettings(kind));
	const [panelOpen, setPanelOpen] = (0, react.useState)(false);
	const [hover, setHover] = (0, react.useState)(null);
	const version = useIndexVersion();
	const index = getIndex();
	const update = (patch) => setSettings((s) => {
		const next = {
			...s,
			...typeof patch === "function" ? patch(s) : patch
		};
		saveSettings(kind, next);
		return next;
	});
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
	]);
	const data = (0, react.useMemo)(() => index?.started && (kind === "global" || center) ? buildGraph(index, settings, queryContext(), center) : null, [
		index,
		version,
		graphKey,
		center,
		kind
	]);
	const onWillOpenRef = (0, react.useRef)(onWillOpen);
	onWillOpenRef.current = onWillOpen;
	(0, react.useEffect)(() => {
		const canvas = canvasRef.current;
		const renderer = new GraphRenderer(canvas, {
			onOpen: (node, e) => {
				if (node.kind === "tag") {
					update({ search: `tag:"${node.label.slice(1)}"` });
					return;
				}
				if (kind === "global" && e.shiftKey) return;
				onWillOpenRef.current?.();
				openNote(node.id);
			},
			onHover: setHover
		});
		rendererRef.current = renderer;
		const themeSub = getEnv().themes.onDidChangeActiveThemes?.(() => setTimeout(() => renderer.readColors(), 100));
		return () => {
			themeSub?.dispose();
			renderer.dispose();
			rendererRef.current = null;
		};
	}, []);
	(0, react.useEffect)(() => {
		rendererRef.current?.setSettings(settings);
	}, [settings]);
	(0, react.useEffect)(() => {
		if (data) rendererRef.current?.setData(data);
	}, [data]);
	(0, react.useEffect)(() => {
		rendererRef.current?.setFocus(focus);
	}, [focus]);
	const hoverRegion = hover?.region ? data?.regions.find((r) => r.id === hover.region) : void 0;
	const counts = data ? `${data.nodes.length} ノート · ${data.links.length} リンク` : "";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: `graph-pane graph-pane-${kind}`,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
				ref: canvasRef,
				className: "graph-canvas"
			}),
			!index?.started && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "graph-message",
				children: "ノートを読み込み中…"
			}),
			index?.started && kind === "local" && !center && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "graph-message",
				children: "ノートを開くと、そのノートのつながりを表示します"
			}),
			data && data.nodes.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "graph-message",
				children: "表示するノートがありません"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "graph-toolbar",
				children: [toolbar, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "graph-counts",
					children: counts
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "graph-zoom",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						title: "拡大",
						onClick: () => rendererRef.current?.zoomBy(1.3),
						children: "＋"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						title: "縮小",
						onClick: () => rendererRef.current?.zoomBy(1 / 1.3),
						children: "−"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						title: "全体を表示",
						onClick: () => rendererRef.current?.fit(),
						children: "⤢"
					})
				]
			}),
			hover && hover.kind === "note" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "graph-hover-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "title",
					children: hover.label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "meta",
					children: [
						hoverRegion && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "region",
							style: { color: hoverRegion.color },
							children: [
								hoverRegion.label,
								" ·",
								" "
							]
						}),
						"リンク ",
						hover.degree,
						" 件 · クリックで開く"
					]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: `graph-settings-toggle${panelOpen ? " active" : ""}`,
				title: "グラフの設定",
				onClick: () => setPanelOpen((o) => !o),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GearIcon, {})
			}),
			panelOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPanel, {
				kind,
				settings,
				update,
				onClose: () => setPanelOpen(false),
				onAnimate: () => rendererRef.current?.animate()
			})
		]
	});
};
GraphPane.displayName = "GraphViewPane";
const GearIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	viewBox: "0 0 24 24",
	width: "16",
	height: "16",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: "1.8",
	strokeLinecap: "round",
	strokeLinejoin: "round",
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
		cx: "12",
		cy: "12",
		r: "3"
	})]
});
const Section = ({ id, title, settings, update, children }) => {
	const open = settings.open[id];
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: `graph-section${open ? " open" : ""}`,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
			onClick: () => update((cur) => ({ open: {
				...cur.open,
				[id]: !cur.open[id]
			} })),
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "chevron",
				children: open ? "▾" : "▸"
			}), title]
		}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "graph-section-body",
			children
		})]
	});
};
const Toggle = ({ label, checked, onChange, hint }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
	className: "graph-row graph-toggle",
	title: hint,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			type: "checkbox",
			checked,
			onChange: (e) => onChange(e.target.checked)
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "switch" })
	]
});
const Slider = ({ label, value, min, max, step, onChange }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
	className: "graph-row graph-slider",
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
		type: "range",
		min,
		max,
		step,
		value,
		onChange: (e) => onChange(Number(e.target.value))
	})]
});
const REGION_CHOICES = [
	{
		value: "tag",
		label: "タグ"
	},
	{
		value: "book",
		label: "ノートブック"
	},
	{
		value: "none",
		label: "なし"
	}
];
const SettingsPanel = ({ kind, settings, update, onClose, onAnimate }) => {
	const s = settings;
	const colorByNotebook = () => {
		update({
			groups: Object.values(getEnv().store.getState().books?.hash ?? {}).filter((b) => !b.parentBookId).sort((a, b) => a.name.localeCompare(b.name)).map((b, i) => ({
				query: `book:"${b.name}"`,
				color: PALETTE[i % PALETTE.length]
			})),
			open: {
				...s.open,
				groups: true
			}
		});
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "graph-settings",
		onKeyDown: (e) => e.stopPropagation(),
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "graph-settings-header",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					title: "既定の設定に戻す",
					onClick: () => update({
						...DEFAULT_SETTINGS,
						open: s.open
					}),
					children: "↺"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					title: "閉じる",
					onClick: onClose,
					children: "✕"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
				id: "filters",
				title: "フィルター",
				settings: s,
				update,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "search",
						className: "graph-search",
						placeholder: "ノートを検索…  tag:x  book:x  -status:dropped",
						value: s.search,
						onChange: (e) => update({ search: e.target.value })
					}),
					kind === "local" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
							label: `深さ（${s.depth}）`,
							value: s.depth,
							min: 1,
							max: 5,
							step: 1,
							onChange: (v) => update({ depth: v })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
							label: "リンク元（被リンク）",
							checked: s.showIncoming,
							onChange: (v) => update({ showIncoming: v })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
							label: "リンク先",
							checked: s.showOutgoing,
							onChange: (v) => update({ showOutgoing: v })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
							label: "近傍のリンク",
							hint: "つながったノート同士のリンクも表示",
							checked: s.neighborLinks,
							onChange: (v) => update({ neighborLinks: v })
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						label: "タグ",
						checked: s.showTags,
						onChange: (v) => update({ showTags: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						label: "孤立したノート",
						hint: "どことも繋がっていないノート",
						checked: s.showOrphans,
						onChange: (v) => update({ showOrphans: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						label: "完了・中止のノート",
						hint: "ステータスが Completed / Dropped のノート",
						checked: s.showClosed,
						onChange: (v) => update({ showClosed: v })
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
				id: "regions",
				title: "領域",
				settings: s,
				update,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "graph-row graph-choice",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "まとめ方" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "graph-segment",
						children: REGION_CHOICES.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: s.regionBy === c.value ? "active" : "",
							onClick: () => update({ regionBy: c.value }),
							children: c.label
						}, c.value))
					})]
				}), s.regionBy !== "none" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						label: "領域を表示",
						hint: "領域の背景と名前を描きます",
						checked: s.showRegions,
						onChange: (v) => update({ showRegions: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "まとまりの強さ",
						value: s.regionForce,
						min: 0,
						max: 1,
						step: .01,
						onChange: (v) => update({ regionForce: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: `領域の数（最大 ${s.maxRegions}）`,
						value: s.maxRegions,
						min: 2,
						max: 30,
						step: 1,
						onChange: (v) => update({ maxRegions: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "graph-hint",
						children: [s.regionBy === "tag" ? "ノートの中で一番多く使われているタグの領域に入ります。" : "最上位のノートブックごとの領域に入ります。", "ノートが少ない領域は「その他」として中央に集まります。"]
					})
				] })]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
				id: "groups",
				title: "グループ",
				settings: s,
				update,
				children: [s.groups.map((g, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "graph-group",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							placeholder: "tag:x / book:x / キーワード",
							value: g.query,
							onChange: (e) => update({ groups: s.groups.map((x, j) => j === i ? {
								...x,
								query: e.target.value
							} : x) })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "color",
							value: g.color,
							onChange: (e) => update({ groups: s.groups.map((x, j) => j === i ? {
								...x,
								color: e.target.value
							} : x) })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							title: "削除",
							onClick: () => update({ groups: s.groups.filter((_, j) => j !== i) }),
							children: "✕"
						})
					]
				}, i)), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "graph-buttons",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "primary",
						onClick: () => update({ groups: [...s.groups, {
							query: "",
							color: PALETTE[s.groups.length % PALETTE.length]
						}] }),
						children: "新しいグループ"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: colorByNotebook,
						title: "最上位のノートブックごとにグループを作り直します",
						children: "ノートブックで色分け"
					})]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
				id: "display",
				title: "表示",
				settings: s,
				update,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						label: "矢印",
						checked: s.arrows,
						onChange: (v) => update({ arrows: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "文字のフェード",
						value: s.textFade,
						min: -3,
						max: 3,
						step: .1,
						onChange: (v) => update({ textFade: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "ノードの大きさ",
						value: s.nodeSize,
						min: .1,
						max: 5,
						step: .05,
						onChange: (v) => update({ nodeSize: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "リンクの太さ",
						value: s.linkThickness,
						min: .1,
						max: 5,
						step: .05,
						onChange: (v) => update({ linkThickness: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "graph-buttons",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "primary",
							onClick: onAnimate,
							title: "ノートを作成順に表示していきます",
							children: "アニメーション"
						})
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
				id: "forces",
				title: "フォース",
				settings: s,
				update,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "中心力",
						value: s.centerForce,
						min: 0,
						max: 1,
						step: .01,
						onChange: (v) => update({ centerForce: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "反発力",
						value: s.repelForce,
						min: 0,
						max: 20,
						step: .1,
						onChange: (v) => update({ repelForce: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "リンクの力",
						value: s.linkForce,
						min: 0,
						max: 1,
						step: .01,
						onChange: (v) => update({ linkForce: v })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
						label: "リンクの距離",
						value: s.linkDistance,
						min: 30,
						max: 500,
						step: 1,
						onChange: (v) => update({ linkDistance: v })
					})
				]
			})
		]
	});
};
//#endregion
//#region src/views.tsx
function flag(initial, onChange) {
	let value = initial;
	const listeners = /* @__PURE__ */ new Set();
	return {
		get: () => value,
		set(next) {
			if (value === next) return;
			value = next;
			onChange?.(next);
			for (const l of listeners) l(next);
		},
		use() {
			const [v, setV] = (0, react.useState)(value);
			(0, react.useEffect)(() => {
				listeners.add(setV);
				setV(value);
				return () => {
					listeners.delete(setV);
				};
			}, []);
			return v;
		}
	};
}
const GLOBAL_CLASS = "graph-view-active";
const LOCAL_KEY = "inkdrop-graph-view:local-open";
const LOCAL_WIDTH_KEY = "inkdrop-graph-view:local-width";
/** Whether the global graph is showing, in place of the note list and editor. */
const globalGraph = flag(false, (v) => document.body.classList.toggle(GLOBAL_CLASS, v));
function loadBool(key) {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}
/** Whether the local graph pane is open beside the editor. */
const localGraph = flag(loadBool(LOCAL_KEY), (v) => {
	try {
		localStorage.setItem(LOCAL_KEY, v ? "1" : "0");
	} catch {}
});
/** The id of the note open in the editor. */
function useEditingNoteId() {
	const read = () => peekEnv()?.store.getState().editingNote?._id ?? null;
	const [id, setId] = (0, react.useState)(read);
	(0, react.useEffect)(() => {
		const unsubscribe = getEnv().store.subscribe(() => setId(read()));
		return () => unsubscribe();
	}, []);
	return id;
}
const GraphIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	viewBox: "0 0 24 24",
	width: "1em",
	height: "1em",
	className: "svg-icon graph-view-icon",
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "1.5",
		strokeLinecap: "round",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "6",
				cy: "6",
				r: "2.25"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "18",
				cy: "8",
				r: "2.25"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "9",
				cy: "18",
				r: "2.25"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "19",
				cy: "19",
				r: "1.5"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 7l7.9.7M7 8l1.6 7.8M10.9 16.9l6.4-7M11.2 18.3l6.3.6" })
		]
	})
});
/** "Graph" entry under All Notes / Templates in the sidebar. */
const SideBarMenuItemGraph = () => {
	const active = globalGraph.use();
	const env = peekEnv();
	if (!env) return null;
	const { SideBarMenuItem } = env.components.classes;
	if (!SideBarMenuItem) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SideBarMenuItem, {
		className: "sidebar-menu-item-graph",
		selectable: true,
		active,
		onClick: () => env.commands.dispatch(document.body, "graph-view:show"),
		renderIcon: () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GraphIcon, {}),
		children: "Graph"
	});
};
SideBarMenuItemGraph.displayName = "GraphViewSideBarMenuItem";
/** Theme colors of the editor area, so the graph matches the theme. */
function useEditorColors() {
	const [colors, setColors] = (0, react.useState)();
	(0, react.useEffect)(() => {
		const read = () => {
			const el = document.querySelector(".main-layout > .editor-layout") ?? document.querySelector(".editor-layout");
			if (!el) return;
			const cs = getComputedStyle(el);
			setColors({
				background: cs.backgroundColor,
				color: cs.color
			});
		};
		read();
		const sub = getEnv().themes.onDidChangeActiveThemes(() => setTimeout(read, 100));
		return () => sub.dispose();
	}, []);
	return colors;
}
const GlobalGraphView = () => {
	if (!globalGraph.use() || !peekEnv()) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GlobalGraphBody, {});
};
GlobalGraphView.displayName = "GraphViewGlobal";
const GlobalGraphBody = () => {
	const env = getEnv();
	const colors = useEditorColors();
	const editingId = useEditingNoteId();
	(0, react.useEffect)(() => {
		const onClick = (e) => {
			const item = e.target.closest?.(".sidebar-layout .sidebar-menu-item");
			if (item && !item.classList.contains("sidebar-menu-item-graph")) globalGraph.set(false);
		};
		document.addEventListener("click", onClick, true);
		let { queryContext, editingNote } = env.store.getState();
		let noteId = editingNote?._id;
		const unsubscribe = env.store.subscribe(() => {
			const state = env.store.getState();
			if (state.queryContext !== queryContext || state.editingNote?._id !== noteId) globalGraph.set(false);
			queryContext = state.queryContext;
			noteId = state.editingNote?._id;
		});
		return () => {
			document.removeEventListener("click", onClick, true);
			unsubscribe();
		};
	}, []);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: "graph-view-global",
		style: colors,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GraphPane, {
			kind: "global",
			focus: editingId,
			onWillOpen: () => globalGraph.set(false),
			toolbar: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "graph-title",
				children: "Graph"
			})
		})
	});
};
const MIN_WIDTH = 220;
const DEFAULT_WIDTH = 360;
function loadWidth() {
	try {
		const w = Number(localStorage.getItem(LOCAL_WIDTH_KEY));
		return w >= MIN_WIDTH ? w : DEFAULT_WIDTH;
	} catch {
		return DEFAULT_WIDTH;
	}
}
const LocalGraphView = () => {
	if (!localGraph.use() || !peekEnv()) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LocalGraphBody, {});
};
LocalGraphView.displayName = "GraphViewLocal";
const LocalGraphBody = () => {
	const colors = useEditorColors();
	const noteId = useEditingNoteId();
	const [width, setWidth] = (0, react.useState)(loadWidth);
	const dragRef = (0, react.useRef)(null);
	const onResizeStart = (e) => {
		e.preventDefault();
		e.target.setPointerCapture(e.pointerId);
		dragRef.current = {
			x: e.clientX,
			w: width
		};
	};
	const onResizeMove = (e) => {
		if (!dragRef.current) return;
		const max = Math.max(MIN_WIDTH, window.innerWidth * .7);
		setWidth(Math.min(max, Math.max(MIN_WIDTH, dragRef.current.w - (e.clientX - dragRef.current.x))));
	};
	const onResizeEnd = () => {
		if (!dragRef.current) return;
		dragRef.current = null;
		try {
			localStorage.setItem(LOCAL_WIDTH_KEY, String(width));
		} catch {}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "graph-view-local",
		style: {
			...colors,
			width
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "graph-resize-handle",
			onPointerDown: onResizeStart,
			onPointerMove: onResizeMove,
			onPointerUp: onResizeEnd
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GraphPane, {
			kind: "local",
			center: noteId,
			focus: noteId,
			toolbar: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "graph-title",
				children: "ローカルグラフ"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "graph-close",
				title: "閉じる",
				onClick: () => localGraph.set(false),
				children: "✕"
			})] })
		})]
	});
};
/** Toggles the local graph pane for the open note. */
const LocalGraphButton = () => {
	const open = localGraph.use();
	const env = peekEnv();
	if (!env) return null;
	const { AppHeaderButton } = env.components.classes;
	if (!AppHeaderButton) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AppHeaderButton, {
		className: `icon graph-view-local-button${open ? " active" : ""}`,
		title: open ? "ローカルグラフを閉じる" : "このノートのローカルグラフを表示",
		onClick: () => env.commands.dispatch(document.body, "graph-view:toggle-local"),
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GraphIcon, {})
	});
};
LocalGraphButton.displayName = "GraphViewLocalButton";
//#endregion
//#region src/index.ts
/** Main layouts that hold the note list and editor. */
const MAIN_LAYOUTS = ["main:full", "main:slim"];
var GraphViewPlugin = class {
	index = null;
	commands = null;
	activate(env) {
		setEnv(env);
		this.index = new GraphIndex();
		this.index.start().catch((err) => {
			console.error("[graph-view] failed to index notes:", err);
			env.notifications.addError("Graph View: ノートの読み込みに失敗しました", {
				detail: err instanceof Error ? err.message : String(err),
				dismissable: true
			});
		});
		env.components.registerClass(LocalGraphButton, "GraphViewLocalButton");
		env.layouts.insertComponentToLayoutBefore("editor-header", "EditorHeaderMore", "GraphViewLocalButton");
		env.components.registerClass(LocalGraphView, "GraphViewLocal");
		env.components.registerClass(GlobalGraphView, "GraphViewGlobal");
		for (const layout of MAIN_LAYOUTS) {
			env.layouts.insertComponentToLayoutAfter(layout, "EditorLayout", "GraphViewLocal");
			env.layouts.insertComponentToLayoutBefore(layout, "NoteListBarLayout", "GraphViewGlobal");
		}
		if (env.isMainWindow) {
			env.components.registerClass(SideBarMenuItemGraph, "GraphViewSideBarMenuItem");
			env.layouts.insertComponentToLayoutAfter("sidebar-menu", "SideBarMenuItemTemplates", "GraphViewSideBarMenuItem");
		}
		this.commands = env.commands.add(document.body, {
			"graph-view:show": {
				description: "Graph View: グラフビューを表示",
				didDispatch: () => globalGraph.set(true)
			},
			"graph-view:toggle": {
				description: "Graph View: グラフビューの表示を切り替え",
				didDispatch: () => globalGraph.set(!globalGraph.get())
			},
			"graph-view:toggle-local": {
				description: "Graph View: ローカルグラフ（開いているノートのつながり）の表示を切り替え",
				didDispatch: () => localGraph.set(!localGraph.get())
			}
		});
	}
	deactivate(env) {
		this.commands?.dispose();
		this.commands = null;
		env.layouts.removeComponentFromLayout("sidebar-menu", "GraphViewSideBarMenuItem");
		env.components.deleteClass(SideBarMenuItemGraph, "GraphViewSideBarMenuItem");
		for (const layout of MAIN_LAYOUTS) {
			env.layouts.removeComponentFromLayout(layout, "GraphViewGlobal");
			env.layouts.removeComponentFromLayout(layout, "GraphViewLocal");
		}
		env.components.deleteClass(GlobalGraphView, "GraphViewGlobal");
		env.components.deleteClass(LocalGraphView, "GraphViewLocal");
		env.layouts.removeComponentFromLayout("editor-header", "GraphViewLocalButton");
		env.components.deleteClass(LocalGraphButton, "GraphViewLocalButton");
		this.index?.stop();
		this.index = null;
		globalGraph.set(false);
		setEnv(void 0);
	}
};
var src_default = new GraphViewPlugin();
//#endregion
module.exports = src_default;

//# sourceMappingURL=index.js.map