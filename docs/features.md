# Features

Decisions, rules and targets: `CLAUDE.md`. Colors: `docs/identity.md`.

## Launcher
First screen. Two choices:
- Create a new vault: pick the folder where it will be saved.
- Open an existing vault.

## Workspace
Extremely fluid, easy to navigate: tactile graph interactions, links, command palette.

Layout: tabs (top) | tree (left) | editor | right column (graph or Brain panel) | status bar (bottom) with the learning indicator.

Shortcuts: `Ctrl+P` single palette (notes by default, `>` for commands). `Ctrl+Shift+L` toggles graph / Brain panel.

## Brain panel (vault query)
Opened by the synapse/chat icon (top right) or `Ctrl+Shift+L`. The graph slides away and the panel takes its place.
- Top: quick search/question box (e.g. "What have I written about GPU architecture?").
- Middle: cards with the exact excerpts from notes: note title in `accent` (`#52B788`) + the relevant paragraph. No generic chat filler.
- Reserved area for a synthesis based only on those cards: hidden until an AI model exists (`CLAUDE.md`, "AI: prepared, not decided").
- Footer: small `learning` (`#F3E9D2`) indicator stating the answer came 100% from the local vault (no internet, no outside knowledge) and which notes were used as sources.
- Search: FTS5 through `brain-adapter.search()`. Semantic search plugs in behind the same call later.

## Pillar A: fluid writing (CodeMirror 6)
- Virtualized rendering: only visible lines are in the DOM. Huge notes edit with no lag.
- Live preview: Markdown syntax (`#`, `**`, `[[ ]]`) is hidden on lines away from the cursor.
- `[[link]]` autocomplete.
- Quick open through the `Ctrl+P` palette.
- Instant navigation: hovering a `[[link]]` shows a floating preview (title + first ~500 chars). Previews for links in the editor viewport are prefetched into an LRU cache, so those hovers take `< 1ms`; a cold hover may take one IPC round-trip.
- Renaming a note updates every `[[link]]` pointing to it.
- Saving: auto-save 500 ms after typing stops (light path). `Ctrl+S` / note switch only bring the heavy path forward. Details: `CLAUDE.md`, rule 2.

## Pillar B: GPU graph
Built as the standalone library `@myelin/graph` (`docs/graph-lib.md`). App target: 100k nodes at 60 FPS.
- Engine: WebGL2 instanced rendering, nodes and edges in few draw calls, read from binary buffers.
- Layout inside the library in a Web Worker: own ForceAtlas2 (LinLog) + Barnes-Hut solver, stops on its own when the system settles. Positions are persisted in `index.db` (by note path) so reopening is instant. Notes created/deleted while the app runs go through the library's incremental API.
- Stable mental map: a new note is born near its neighbors and only its neighborhood relaxes; the rest of the graph does not move.
- Labels: at most ~50-100 visible at once, by priority (connections, weight), overlapping ones skipped. Drawn on a transparent Canvas 2D layer over the WebGL2 canvas.
- Semantic zoom:
  - Far: only luminous constellations grouped by density. No text.
  - Mid: titles of hubs (most connected notes).
  - Near: individual notes and direct links.
- Myelination: edge thickness/brightness follows its usage weight (Pillar D).
- GPU micro-animations:
  - Bioluminescent breathing: soft glow waves on recently edited nodes (fragment shader).
  - Synaptic impulse: creating a `[[link]]` in the editor sends an ivory (`#F3E9D2`) beam along the edge to the target node, which pulses.
  - Tactile attraction: hovering a node lights up neighbor edges in a cascade.

## Pillar C: backend and storage
- `vault-worker.ts` (worker thread) owns file I/O (atomic writes), the `chokidar` watcher, `[[link]]` parsing, SQLite and the heavy-path processors. The UI never blocks. Save pipeline: `CLAUDE.md`, rule 2.
- In the vault, `.myelin/` holds only text: `vault.json` (vault id) and `usage.jsonl` (learning events, not rebuildable). Safe to sync.
- `index.db` (`better-sqlite3`, WAL) lives outside the vault, in the app's `userData`: notes, links, FTS5, graph positions, edge weights. Fully rebuildable from the `.md` + `usage.jsonl`.

## Pillar D: learning (`brain-adapter.ts`)
Now (stage 3, no AI):
- Myelination: usage events strengthen edges: following a link, opening two notes together, two notes retrieved together. Events are appended to `.myelin/usage.jsonl`; weights are computed into `index.db` and feed the graph.
- No AI queue is written now: future processors catch up through content hashes (`CLAUDE.md`, rule 2).

Later (AI, decided after stage 4): semantic search, suggested links, syntheses of changed notes. They plug into the slots in `CLAUDE.md`, "AI: prepared, not decided".
