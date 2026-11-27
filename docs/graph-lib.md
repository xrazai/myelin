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
   - Density clusters for far zoom are computed here too.
5. Buffers move between threads by transfer (`postMessage(buf, [buf])`), double-buffered. `SharedArrayBuffer` is an opt-in, never required (it forces cross-origin isolation on the host page).
6. Labels: `options.getLabel(nodeId: number) => string`, same numeric id as the buffers (an array is wrapped as `id => labels[id]`). The library only calls it for visible nodes. At most ~50-100 labels drawn at once, by priority (degree, weight), skipping overlaps (same spatial hash as hover). Drawn on a transparent Canvas 2D layer over the WebGL2 canvas: any font, any character, no strings sent to the GPU, no DOM nodes.
7. App-specific code (notes, SQLite, IPC, palette values) never goes inside the library; colors come in through `options`.
8. Node ids: dense slot indices owned by the host's mapping, valid for one session. A removed node becomes a tombstone (hidden, slot goes to a free list and may be reused by `addNodes`). No compaction during a session; `setGraph` (full load) is the only compaction. Hosts persist by their own keys (Myelin: note path), never by node id.
9. Edges are identified by their `(source, target)` pair; the library keeps the pair -> slot map internally.
10. Labels and WebGL stay in sync: both canvases read the same camera state and `devicePixelRatio`, are resized together, and are drawn in the same `requestAnimationFrame`. Never update the camera between the two draws (otherwise labels "float" behind nodes during pan/zoom).

## API
Data:
- `graph.setGraph({ nodeCount, edges, weights, states, positions? })`: full load (vault open). Resets ids.
- `graph.addNodes(count, { positions?, states? }) => ids`: new nodes start at the centroid of their neighbors once their edges arrive.
- `graph.removeNodes(ids)`: tombstones; their edges are removed.
- `graph.addEdges(pairs, weights)`, `graph.removeEdges(pairs)`, `graph.updateWeights(pairs, weights)`: `pairs` is a `Uint32Array` `[s0, t0, s1, t1, ...]`.
- `graph.updateStates(ids, values)`.

Effects and events:
- `graph.pulseEdge(sourceId, targetId)`: light beam between two nodes.
- `graph.focusNode(nodeId, { duration: 600 })`: smooth camera glide to a node.
- `graph.on('nodeHover', (id) => ...)`: hover hit-test in `< 0.1ms` (spatial hash).
- `graph.on('layoutChange', (positions) => ...)`: lets the host persist positions (by its own keys).

## Later
Millions of nodes, WebGPU backend and GPU compute layout, MSDF text in WebGL (only worth it for thousands of labels), edge bundling, spatial streaming, Pro tier.

## Open points
- npm scope `@myelin`: see `AGENTS.md`, "Decide later".
