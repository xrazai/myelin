# Graph library (`@myelin/graph`)

Standalone library in `packages/graph/`, to be published as open source on npm later. Myelin is its first consumer.

Positioning: GPU graph with organic shaders and fluid animations out of the box. Claims about other libraries (D3, Cytoscape, Vis, Sigma, Cosmograph) are unverified; benchmark before using them in any pitch.

## Rules
1. No UI or Electron dependencies. Input is a `<canvas>` plus options: `new MyelinGraph(canvas, options)`. Must run in Electron, the browser, React, Vue, Svelte.
2. WebGL2 only (GLSL ES 3.0). The graphics backend sits behind an internal interface so WebGPU can be added later without touching the public API.
3. Data-oriented input. Numeric buffers only, no note objects (full load via `setGraph`, then incremental calls; see API):
   - `edges`: `Uint32Array` `[source0, target0, source1, target1, ...]`
   - `weights`: `Float32Array` (edge strength: thickness/brightness)
   - `states`: `Float32Array` (glow / activity per node)
   - `positions` (optional): `Float32Array` `[x0, y0, x1, y1, ...]` to start from saved positions.
4. Layout is part of the library, in a Web Worker, with our own solver (no dependency):
   - Structure of Arrays: `Float32Array` for positions/velocities/forces, Barnes-Hut quadtree flattened into typed arrays. No per-node JS objects.
   - ForceAtlas2, LinLog mode (clear clusters for far zoom), Barnes-Hut approximation (in-memory quadtree in the worker).
   - Early stopping: stops when total movement / kinetic energy drops below a threshold.
   - Incremental: a new node starts at the centroid of its neighbors; a local temperature/damping relaxes only that neighborhood instead of reheating the whole graph (stable mental map).
   - Deterministic seed: same graph, same picture.
   - First layout of a large graph can take tens of seconds to minutes in JS; acceptable because the host persists positions.
   - The worker also runs community detection (rule 11).
5. Buffers move between threads by transfer (`postMessage(buf, [buf])`), double-buffered. `SharedArrayBuffer` is an opt-in, never required (it forces cross-origin isolation on the host page).
6. Labels: `options.getLabel(nodeId: number) => string`, same numeric id as the buffers (an array is wrapped as `id => labels[id]`). The library only calls it for visible nodes. At most ~50-100 labels drawn at once, by priority (degree, weight), skipping overlaps (same spatial hash as hover). Drawn on a transparent Canvas 2D layer over the WebGL2 canvas: any font, any character, no strings sent to the GPU, no DOM nodes.
7. App-specific code (notes, SQLite, IPC, palette values) never goes inside the library; colors come in through `options`.
8. Node ids: dense slot indices owned by the host's mapping, valid for one session. A removed node becomes a tombstone (hidden, slot goes to a free list and may be reused by `addNodes`). No compaction during a session; `setGraph` (full load) is the only compaction. Hosts persist by their own keys (Myelin: note path), never by node id.
9. Edges are identified by their `(source, target)` pair; the library keeps the pair -> slot map internally.
10. Labels and WebGL stay in sync: both canvases read the same camera state and `devicePixelRatio`, are resized together, and are drawn in the same `requestAnimationFrame`. Never update the camera between the two draws (otherwise labels "float" behind nodes during pan/zoom).
11. Constellations are real groups, drawn with GPU glow:
   - Meaning: hierarchical community detection (Leiden) on the weighted edge graph, in the worker. Levels of the hierarchy = levels of semantic zoom. Weights come from `weights`, so use shapes the groups.
   - Stability: recompute debounced on idle after graph changes; new communities are matched to old ones by overlap so ids, colors and names do not jump. Hosts can pass a saved assignment (`setGraph({ communities })`) for instant open.
   - Drawing: nodes splatted with additive blending into a low-resolution offscreen texture per visible level, then blurred; the glow follows community membership, not just density, so neighbors from different subjects do not merge.
   - Naming: the library exposes for each community its most central nodes; the host names it (Myelin: title of the top node now; the AI slot may name it later).
   - Fast enough: Leiden on 100k nodes / ~300k edges is seconds in a worker; never blocks drawing.

## API
Layout alone, no canvas (done; `MyelinGraph` composes it):
- `new GraphLayout(options?)`: solver options (`LayoutOptions`, defaults in `layout/forceatlas2.ts`) and `createWorker?`.
- `setGraph({ nodeCount, edges, weights?, positions? })` runs until it settles (caller's arrays are copied); `positions` getter, `stop()`, `destroy()`, `on` / `off`.
- Events: `layoutChange`, and `layoutError (error)`.
- A graph with every position saved settles almost at once; a node with a non-finite coordinate gets a seeded one.
- First layout, solver only: `node scripts/bench-layout.ts`.

Graph on a canvas (done: drawing and camera):
- `new MyelinGraph(canvas, { colors?, layout?, createWorker? })`; `destroy()`. The page gives the canvas a CSS size; the library sets its backing size (DPR-aware).
- `colors`: `background`, `node`, `activeNode` (by `states`), `edge`, `strongEdge` (by weight), `#rgb` or `#rrggbb`; neutral defaults.
- `fit()` shows the whole graph and follows the layout again; the camera follows it until the user (or the host) moves it. `camera` get / set: `{ x, y, zoom }` (world center, CSS px per world unit).
- Input: drag or one finger pans, two fingers pinch; mouse wheel zooms at the pointer; trackpad scroll pans, trackpad pinch zooms. Browsers do not name the device: a wheel gesture that starts sideways or with a step under 40 px is a trackpad (`src/controls.ts`).
- Draws only when something changed. A lost WebGL context is restored.
- `on` / `off`: the layout events.
- Demo: `npm run demo -w @myelin/graph` (`?nodes=100000`).

Drawing (`src/backend/`, `src/shaders/`):
- Positions in one RG32F texture, read by node id: a layout update uploads only it; edge instances hold two ids and a strength.
- Edge strength `w / (w + 1)` (weight 1 when absent) sets width (0.5-2 CSS px), opacity and color. Node radius grows with the square root of the degree, with a floor and a ceiling in pixels.
- `node scripts/bench.ts --graph`: GPU and CPU per frame and the weak-GPU estimate (a model, error up to ~2x; `scripts/gpu-profiles.json`).
- For now the GPU budget applies to the whole-graph view only. Zoomed in (2x and more) it is over (GPU 1.7-3.2 ms at 100k): edge fill, #73.

Adaptive quality, defaults chosen with that estimate (not implemented yet, #40; the bloom measured by the bench is a stand-in):
- Bloom at 1/2 resolution; below 50 FPS go to 1/4, then off. Never drop nodes.
- Weak GPUs at 100k are bound by nodes and edges: turning the glow off does not bring them to 50 FPS.

Data (done: incremental calls; `communities` comes with #42):
- `graph.setGraph({ nodeCount, edges, weights?, states?, positions?, communities? })`: full load (vault open). Resets ids.
- `graph.addNodes(count, { positions?, states? }) => ids`: new nodes start at the centroid of their neighbors once their edges arrive.
- The changes of one task are applied together: one GPU patch (`bufferSubData`; arrays double when they fill) and one local pass in the worker (`layout/relax.ts`): the new nodes move freely, their neighbors a little, every other node stays exactly. Past 2000 movable nodes, or while a full layout runs, the living nodes are laid out again from where they are.
- `layoutChange` positions are by node id; NaN for a removed or unplaced node.
- `graph.removeNodes(ids)`: tombstones; their edges are removed.
- `graph.addEdges(pairs, weights)`, `graph.removeEdges(pairs)`, `graph.updateWeights(pairs, weights)`: `pairs` is a `Uint32Array` `[s0, t0, s1, t1, ...]`.
- `graph.updateStates(ids, values)`.

Effects and events:
- `graph.pulseEdge(sourceId, targetId)`: light beam between two nodes.
- `graph.focusNode(nodeId, { duration: 600 })`: smooth camera glide to a node (done); user input stops it.
- Hover and labels (done): `nodeHover (id | null)` and `nodeClick (id)` come from a hash grid over the world positions (`hit-grid.ts`; hubs checked one by one), rebuilt only when positions changed and the pointer asks. Labels need `getLabel` and `labelCanvas`: a transparent canvas the host stacks exactly over the graph's, `pointer-events: none`; `labelStyle { color, font }`. At most 100, best linked first (degree, then summed weight), the hovered one first, overlaps skipped.
- `graph.on('nodeHover', (id) => ...)`: hover hit-test in `< 0.1ms` (spatial hash).
- `graph.on('layoutChange', (positions, { iteration, done, converged }) => ...)`: lets the host persist positions (by its own keys). `positions` is only valid until the next event (its buffer returns to the worker): copy what you keep. `done` marks the last one.
- `graph.on('communityHover' | 'communityClick', (communityId, level) => ...)`, `graph.on('nodeClick', (id) => ...)`.
- `graph.getCommunity(id) => { level, size, topNodes, parent, children, neighbors: [{ id, weight }] }`: what the host needs for names, cards and "related subjects".
- `graph.focusCommunity(id, { duration })`: camera fits the community.
- `graph.on('communitiesChange', (assignment) => ...)`: lets the host persist the assignment.

## Later
Millions of nodes, WebGPU backend and GPU compute layout, MSDF text in WebGL (only worth it for thousands of labels), edge bundling, spatial streaming, Pro tier.

## Open points
- npm scope `@myelin`: see `AGENTS.md`, "Decide later".
