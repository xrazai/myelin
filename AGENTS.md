# Myelin

Desktop app over a vault of `.md` notes that learns from how you write and navigate. Editor, file tree, GPU graph, Brain panel (vault query).

Goal priority:
1. The personal vault that learns (Rafa's daily use). Scale and scope decisions serve this.
2. `@myelin/graph` as an open-source library. Library-only ambitions go to "Later".

Status: stage 1 in progress (app scaffold in place). Repo: https://github.com/xrazai/myelin (branch `main`).

## Commands
`npm install`, `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`, `npm run preview`, `npm run gen-vault -- --notes 10000 --seed 1` (synthetic vault outside the repo; options in `scripts/gen-vault.ts`).

## Language rule
- Everything in the project is in English: code, identifiers, comments, file and folder names, UI text, docs.
- Portuguese only for conversation with Rafa and between agents.

## Decisions
- Runtime: Electron. Language: TypeScript everywhere (ESM).
- Build: `electron-vite`. Vite dev server on localhost is allowed in development only; the shipped app opens no ports and runs no HTTP server.
- Tests: vitest, `*.test.ts` next to the code. TypeScript stays on 6.x until `svelte-check` accepts 7; `@types/node` follows the Node bundled in Electron.
- Svelte components always use `<script lang="ts">` (without it `svelte-check` treats them as untyped JS).
- Renderer runs sandboxed, so the preload is built as CommonJS (`preload.cjs`).
- UI shell: Svelte 5 (runes).
- Internal communication: IPC only (`contextBridge`, `contextIsolation: true`). Every channel is declared in `src/shared/ipc.ts`; only `preload.ts` and `main/ipc.ts` touch Electron IPC (enforced by `main/ipc.test.ts`).
- Storage:
  - Inside the vault, `.myelin/` holds only text files: `vault.json` (`{ "id": <UUID>, "formatVersion": 1 }`; created when missing, never overwritten; the vault does not open if it is invalid or has another version) and `usage.jsonl` (learning events). Safe to sync with Git, Syncthing or cloud folders.
  - Index: `better-sqlite3` (WAL, FTS5) at `<userData>/vaults/<vault-id>/index.db`, outside the vault. 100% rebuildable; never synced (SQLite + WAL in a synced folder risks corruption and binary conflicts). Native module: `better-sqlite3` >= 13 ships Node-API prebuilds, so one binary serves Node (tests) and Electron: no `@electron/rebuild`, and its install script stays denied (`allowScripts`).
  - Index code: `main/vault-index.ts`. Tables `notes` (with the content hash), `links` (one row per link, `target_path` or unresolved `name`) and `notes_fts`. Schema change = bump `SCHEMA_VERSION` (rebuilds). `open` returns at once and the index syncs in the background (new, changed by mtime + size then hash, removed); a failing index never keeps a vault from opening. Anything that adds or removes notes must re-resolve the affected links in the same transaction.
- Search: FTS5, tokenizer `unicode61 remove_diacritics 2` (Portuguese-friendly; `porter` is English-only).
- Editor: CodeMirror 6.
- Graph: `@myelin/graph`, WebGL2 only (GLSL ES 3.0), graphics backend behind an internal interface. Layout: own ForceAtlas2 (LinLog) + Barnes-Hut solver inside the library, no dependency (`docs/graph-lib.md`).
- Fonts: Literata (body serif), Inter (UI), JetBrains Mono (code, raw syntax, metadata). Bundled (offline), variable, OFL.
- Shortcuts: `Ctrl+P` is a single palette (notes by default, `>` prefix for commands). `Ctrl+Shift+L` toggles graph / Brain panel. `Ctrl+\` toggles Focus Mode (collapses both side panels). `Ctrl+Shift+B` toggles the file tree. `Ctrl+S` saves now.

## AI: prepared, not decided
No AI model is chosen or built now. The app ships ready to receive it, through three slots:
1. `brain-adapter.ts` is the only door to "intelligence". Interface: `search(query) -> cards[]` (note path, title, excerpt, score) and `process(changedNote)`. Now it is implemented with FTS5. Semantic search and a local model plug in behind it later, without touching the UI.
2. Heavy path of the save pipeline (rule 2): a list of processors over changed notes. Empty now. Each future processor keeps its own last-processed content hash per note, so when it arrives it catches up on everything that changed; nothing is lost and no queue file grows in the meantime.
3. Brain panel shows excerpt cards with sources now; it has a reserved area for a synthesis that stays hidden until a model exists.
Do not create tables, dependencies, queues or files for AI before the decision. See "Decide later".

## Rules
1. Source of truth is the `.md` files plus `.myelin/usage.jsonl`.
   - `index.db` is derived from both: it can be deleted at any time (schema migration = drop and rebuild).
   - External edits are picked up by the watcher and reindexed.
   - Renaming a note updates every `[[link]]` pointing to it.
   - Owner: `vault-worker.ts` owns all file I/O, the `chokidar` watcher, parsing and SQLite. `main.ts` only manages windows and routes IPC.
2. Save pipeline: two paths.
   - Light path, auto-save 500 ms after typing stops: atomic write, FTS5 update, link/edge update, synaptic pulse for new `[[link]]`s.
   - No text is lost or silently overwritten (`renderer/editor/note-saver.ts`):
     - `writeNote(path, content, base)` writes only if the disk still holds `base` (the text read or last written; `null`: no note), checked again right before each rename. Otherwise it returns a conflict. This covers an external edit whose watcher report has not arrived yet.
     - A note is written only when its text differs from what was read or written, so opening, switching or blur never rewrites it. A file that is not UTF-8 is never overwritten.
     - Note switch, tab close, window blur, app quit and reload save at once. A tab or the window stays open while text cannot be saved; only the user gives it up. `beforeunload` holds the window until the saves end; then `resumeUnload` makes main do the close or reload that was asked.
     - External change on an open note, decided by content: clean editor reloads (cursor, scroll and undo history stay); dirty editor keeps its text and auto-save stops until "keep mine" or "load disk version" (undoable). A deleted note with edits is not recreated until the user asks.
     - A failed write shows the error and is retried on the next save trigger, not in a loop.
   - Heavy path: runs the registered processors (none yet) on every note whose content hash differs from what that processor last saw. `Ctrl+S`, note switch, a few seconds idle, window blur and app close only bring it forward; on startup, pending notes are processed. Correctness never depends on a trigger, and external edits go through the same path.
   - Atomic write on Windows: write `<note>.md.tmp`, `fsync`, then rename over the original. Retry the rename on `EPERM`/`EBUSY`/`EACCES` (antivirus, OneDrive, indexer holding the file).
   - Watcher loop guard: ignore `*.tmp`; before writing, the worker records the expected content hash of each file it is about to write, and a watcher event whose file hash matches is dropped. Any event whose hash equals the indexed hash is a no-op.
   - Watcher (`main/vault-watcher.ts`): what chokidar reports (its events and `raw`) only marks paths to look at. `VaultEvent`s come from comparing folder listings with the last reported tree, and `changed` from content hashes. Never forward chokidar events: on Windows it misses repeated case-only renames. The tree is updated at once; the index waits for the first sync. The worker writes notes only through `VaultWatch.write`. An app write that creates a note (or its folders) is the one own write reported, as `created`.
   - Rename is one batch: rename the file, rewrite the linking notes, reindex once. Those rewrites are marked as link-only and do not count as content changes for the heavy path (the renderer still gets `changed`, to reload open notes).
     - Every link keeps leading where it did, those to a namesake the new name would capture included; `[[#Heading]]` is never rewritten. Open notes are saved first, and each rewrite follows the `writeNote` base rule: a note that cannot be rewritten is reported, not overwritten.
     - Only the notes the index says can be affected are read, plus those it is behind on.
3. The main thread never blocks: scanning, parsing, indexing and heavy processors run in workers.
4. Golden rule: Svelte owns only the shell (file tree, tabs, palette, status bar, Brain panel). CodeMirror 6 and `@myelin/graph` run in plain TS inside containers mounted by Svelte, outside its reactivity.
5. Graph data crosses boundaries as typed arrays (`Float32Array` / `Uint32Array`).
   - Between threads: transfer the `ArrayBuffer` (`postMessage(buf, [buf])`), double-buffered. No copy, no special headers.
   - `SharedArrayBuffer` is optional, never required: it needs cross-origin isolation, a burden for library users.
   - Main process <-> renderer over IPC is a copy, and so is every GPU upload. Both are cheap (100k nodes x/y = 800 KB).
   - Graph node ids are session-local dense indices assigned by `graph-view.ts`. Persisted data (positions, weights) is keyed by note path, never by node id.
6. Performance claims are proven by the benchmark in `scripts/`, never assumed.
7. Single stack: everything in Electron/Node. No Python, no external services, no HTTP servers. Only outbound connection: the update check (see Releases and updates).
8. Text encoding and line endings (enforced by `.editorconfig` and `.gitattributes`):
   - Every text file is UTF-8 without BOM, LF.
   - Exception, the user's notes: saving keeps the BOM and line ending (`\r\n`, `\n` or `\r`; mixed: the most used, LF on a tie) a note had on disk (`renderer/editor/note-text.ts`; the editor works on LF text without BOM). New notes follow the rule above.
   - Shell: use `pwsh` (PowerShell 7) or Git Bash. In Windows PowerShell 5.1, never write project files with `Out-File` or `>` (UTF-16 by default); prefer the agent's file tools.
   - Node code reading/writing files always passes `'utf8'` explicitly.
   - Never parse localized text printed by Windows tools (e.g. `chcp`, `ipconfig`); use exit codes or structured output (JSON).

## Targets (app)
- Graph: 100k nodes at 60 FPS with glow, with headroom for weaker GPUs. Bloom/glow cost scales with pixels, not nodes.
  - Dev machine: i7-12700KF + RTX 5070 Ti (no integrated GPU). Plain FPS here proves little, so `bench` measures GPU time per frame instead: offscreen 2880x1800, 100k nodes, glow on (`EXT_disjoint_timer_query_webgl2`; fallback: N frames with `gl.finish()` and wall time). Budget: <= 1.5 ms GPU and <= 4 ms CPU per frame. This is a regression guard, not proof for other hardware.
  - Weak-GPU estimate (simulation, no extra hardware): `bench` measures cost per pixel and per node/edge here, then scales them by memory bandwidth and FP32 throughput of reference profiles (`scripts/gpu-profiles.json`: Intel Iris Xe, UHD 770, N100) and prints estimated FPS per glow quality. Expected error up to ~2x; used to choose the adaptive-quality defaults (#35).
  - Weaker hardware is covered by adaptive quality in the library: below ~50 FPS it lowers bloom resolution, then turns glow off; it never drops nodes.
  - No dedicated integrated-GPU testing. If a user reports slowness on weak hardware, that report becomes an issue.
- Link hover preview `< 1ms` for links visible in the editor: `note-cache.ts` is an LRU of short previews (title + first ~500 chars), prefetched for the `[[links]]` in the editor viewport. A cold hover (not prefetched) may take one IPC round-trip. Never hold full note texts for the whole vault in the renderer.

## Benchmark (`scripts/bench.ts`)
On `gen-vault` output (10k / 100k notes): graph FPS with glow, hover latency (warm and cold), FTS5 indexing time. First layout time is measured by `node scripts/bench-layout.ts`.
`--editor` (`scripts/bench-editor.ts`): typing latency of the editor, with real key events in the repo's Electron (needs a desktop session). Budget on a 10k-line note: p95 <= 16 ms from keydown to the DOM updated and laid out.

## Learning (what "Myelin" means in code)
**Paused** (#34, label `paused`; see Workflow): do not build any of this until the maintainer resumes it. What already exists stays (a rename still appends its `renamed` event).

Now, no AI: myelination. Edges you use get stronger.
- Usage events (link followed, notes co-opened, notes co-retrieved in a search, note renamed) are appended to `.myelin/usage.jsonl`: plain text, append-only, keyed by note path. A rename is an event, so old lines never need rewriting.
- Edge weights are computed from these events into `index.db`. The graph draws strong edges thicker and brighter.
- Growth: when the file gets large, compact it into one snapshot line of weights per edge followed by new events.
AI-based learning comes through the slots above.

## Planned structure
npm workspaces: the app at the root, the graph library in `packages/graph/` (own `package.json`, publishable on its own). The app imports it by package name, never by relative path into its source.
```
myelin/
├── package.json               # app + "workspaces": ["packages/*"]
├── electron.vite.config.ts
├── packages/
│   └── graph/                 # @myelin/graph (docs/graph-lib.md); no Electron/UI deps
│       ├── package.json
│       └── src/
│           ├── index.ts       # MyelinGraph public API
│           ├── backend/       # WebGL2 backend behind an internal interface
│           ├── layout/        # layout Web Worker (ForceAtlas2 + Barnes-Hut, incremental)
│           └── shaders/       # GLSL: glow, synaptic pulse, semantic zoom
├── scripts/
│   ├── gen-vault.ts           # synthetic vaults (10k / 100k notes)
│   ├── bench.ts               # performance benchmark
│   └── bench-editor*          # `bench --editor`: typing latency (runner, Electron main, page)
├── src/
│   ├── main/
│   │   ├── main.ts            # windows, menus, IPC routing
│   │   ├── ipc.ts             # registers the contract's handlers, sends its events
│   │   ├── vault-worker.ts    # file I/O (atomic), watcher, parsing, index.db, FTS5, usage events, heavy path
│   │   ├── vault-config.ts    # .myelin/vault.json (used by vault-worker)
│   │   ├── vault-path.ts      # validates note paths from the renderer (used by vault-worker)
│   │   ├── vault-index.ts     # index.db: schema, sync and updates (used by vault-worker)
│   │   ├── vault-watcher.ts   # chokidar watcher, loop guard, tree events, rename batch (used by vault-worker)
│   │   ├── vault-usage.ts     # appends learning events to usage.jsonl (used by vault-worker)
│   │   └── brain-adapter.ts   # AI slot: search(query), process(changedNote); FTS5 now
│   ├── preload/preload.ts     # contextBridge, exposes window.myelin
│   ├── shared/ipc.ts          # window.myelin contract: types and channel names
│   └── renderer/              # Nocturnal Botany UI (Svelte 5 shell)
│       ├── index.html
│       ├── index.ts           # mounts App.svelte
│       ├── App.svelte         # launcher -> workspace
│       ├── styles.css         # palette and font variables (docs/identity.md)
│       ├── fonts/             # Literata, Inter, JetBrains Mono (variable, OFL) + fonts.css
│       ├── public/licenses/   # font licenses, copied into the build
│       ├── components/        # Launcher, Workspace, FileTree, Tabs, Editor, CommandPalette, StatusBar, BrainPanel (.svelte)
│       ├── editor/
│       │   ├── cm-editor.ts   # CodeMirror 6 (one view, a state per tab); [[link]] autocomplete and hover plug in here
│       │   ├── editor-tabs.ts # tabs -> editor: opens a note when its tab is first shown, saves the one left
│       │   ├── note-saver.ts  # auto-save, save triggers, external changes and conflicts
│       │   ├── note-text.ts   # a file's BOM and line endings <-> the editor's text
│       │   ├── text-changes.ts # minimal changes for a reload that keeps cursor and scroll
│       │   ├── live-preview.ts # hides Markdown syntax away from the cursor (visible ranges only)
│       │   ├── wiki-link.ts   # [[link]] in the Lezer parser, same grammar as shared/links.ts
│       │   ├── link-syntax.ts # the link at a position (tables included), never in code
│       │   ├── link-complete.ts # [[ completion: note names, then headings after Note#
│       │   ├── headings.ts    # a note's headings, for that completion
│       │   ├── link-follow.ts # Ctrl+Click / Ctrl+Enter (+Shift: new tab); creates a missing note
│       │   ├── link-hover.ts  # viewport-prefetched hover preview card (< 1 ms warm)
│       │   ├── link-pulse.ts  # a save that adds a link -> `myelin:link-pulse` window event
│       │   ├── focus-dim.ts   # optional paragraph focus dimming mode (off by default)
│       │   ├── note-metrics.ts # debounced word count, read time and link count for StatusBar
│       │   ├── note-path.ts   # which note an editor state holds
│       │   └── theme.ts       # editor look, from the identity tokens
│       ├── tree-model.ts      # file tree logic: visible rows, watcher events, keyboard
│       ├── note-list.ts       # every note path (no content), kept current by watcher events
│       ├── note-search.ts     # fuzzy search over note names, ignoring case and accents
│       ├── note-cache.ts      # LRU of short previews, viewport prefetch
│       ├── rename-note.ts     # rename order: save, worker batch, move tab and editor state
│       └── graph-view.ts      # glue: note path <-> node id, feeds @myelin/graph, wires events
└── vault-dev/                 # local test vault
    ├── .myelin/
    │   ├── vault.json           # vault id, format version
    │   └── usage.jsonl          # learning events (not rebuildable)
    └── Home.md
```
Index outside the vault: `<userData>/vaults/<vault-id>/index.db`.

Screens: launcher (create or open a vault) -> workspace. Create and Open run the same operation on the picked folder (the dialog lives in main); only the dialog labels differ.
Workspace layout: tabs (top) | tree (left) | editor | graph or Brain panel (right) | status bar (bottom) with the learning indicator.

## Workflow (GitHub)
- Board: GitHub Project "Myelin", https://github.com/users/xrazai/projects/7. Status: Backlog -> Todo -> In progress -> Done.
- Every piece of work is an issue, in English. ID = issue number (`#12`). Labels: type (`task`, `bug`, `enhancement`, `documentation`) + `area: vault|editor|graph|ui|tooling`. Milestone = roadmap stage.
- `paused`: on hold, to be resumed later (work given up is closed as "not planned" instead). The issue stays open, in Backlog, even with no open blocker. Agents do not pick it, move it or work on it, even when asked by number: they say it is paused and ask. Only the maintainer pauses and resumes. An issue blocked by a paused one stays blocked: tell the maintainer.
- `needs decision`: waits for the maintainer; stays in Backlog.
- Impact review: creating an issue, changing its scope, pausing it or closing it as "not planned" is not done until every open issue was checked against it. Agents update the ones that are now outdated or lack information (text, `Depends on:` and "Blocked by" links, shared files that must not run in parallel, priority, board status). One that no longer makes sense as a whole is not closed or paused: they tell the maintainer. They report what changed and why, or that nothing did.
- License: MIT for everything (app and `@myelin/graph`). Every `package.json` says `"license": "MIT"`; `packages/graph` ships its own `LICENSE`.
- Community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/CODEOWNERS`, templates in `.github/` (bug, feature, task, PR; blank issues off).
- Solo flow (Rafa): commit straight to `main` (ruleset bypass); the commit that finishes an issue ends its message with `Closes #N` (partial work: `Refs #N`). Closing moves the card to Done. Rafa's agents follow `CLAUDE.local.md` (local, git-ignored) for when to commit, push and open PRs; if it is missing, ask before any push.
- Commit messages: Conventional Commits, `type(scope): subject` in English, imperative, lower case, no period. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`. Scope = area (`vault`, `editor`, `graph`, `ui`, `tooling`) when it fits. Breaking change: `type(scope)!: subject`. PR titles use the same format (the squash commit takes the PR title).
- Contributors: fork, branch `<issue>-short-slug`, PR with `Closes #N`. Ruleset "Protect main": PR required, review threads resolved, no force push, no deletion; no required approval (only maintainers can merge anyway; CODEOWNERS still requests review). Rafa (admin) bypasses for direct pushes. Merge: squash only (PR title = commit), branch deleted after merge. CI (`.github/workflows/ci.yml`) runs on PRs and pushes to `main`; every CI job goes in the `needs` of the `all-checks` job. Every `uses:` is pinned to a full commit SHA with the full version as a comment (`# v7.0.1`; Dependabot updates both). The `actionlint` job lints all workflows on every PR. `all-checks` is a required check, not strict (a PR behind `main` can merge if its own CI passed, as in NousResearch/hermes-agent; strict mode left PRs stuck behind every merge). Auto-merge is on: PRs are created with `gh pr merge --auto --squash` and merge themselves when `all-checks` passes. CI also runs on every push to `main`; a red `main` is fixed before anything else.
- `bench.yml` compares the benchmark of each PR with its base; not required, kept out of `ci.yml` so it is not in `all-checks`. It never comments on the PR (comments send e-mail): read the table in the run's job summary; a slower metric shows as a warning annotation.
- Security: private vulnerability reporting on; Dependabot alerts and security updates on; secret scanning with push protection on; CodeQL default setup on (JS/TS and Actions, weekly + PRs, not a required check).
- Automations: new issues/PRs are auto-added to the board in Backlog; closed/merged -> Done; card moved to Done -> issue closed; PR linked -> In progress.
- Change status: `gh project item-edit 7 --owner xrazai --url <issue-url> --field Status --value "In progress"` (values: Backlog, Todo, In progress, Done).
- New issue: `gh issue create -R xrazai/myelin` with labels + milestone; it lands in Backlog by itself.
- Dependencies: native GitHub "Blocked by" links (plus a readable `Depends on: #a, #b` line in the body). An issue is ready when it has no open blocker: `gh api repos/xrazai/myelin/issues/N --jq .issue_dependencies_summary.blocked_by` returns `0`.

## Releases and updates
- Packaging: `electron-builder` (NSIS on Windows). Updates: `electron-updater`, GitHub provider.
- Release = push a SemVer tag `vX.Y.Z` (`0.x` until stable); GitHub Actions builds and publishes the installer + `latest.yml` to GitHub Releases. Release notes are the release body and show in the app's "What's new".
- Network rule: the update check to GitHub Releases is the app's only outbound connection. It sends no vault data and can be turned off in settings. Everything else stays offline.
- Windows first. macOS (signing + notarization) and Linux later. Code signing: decide later (unsigned = SmartScreen warning on first install).
- Tracked in #12.

## Roadmap
1. Skeleton, I/O and proof tools: themed window, launcher, file tree, `vault-worker` (atomic writes, watcher loop guard, `index.db` + FTS5), `gen-vault` and `bench`.
2. Fluid editor: CodeMirror 6, live preview, `Ctrl+P` palette, `[[link]]` autocomplete, rename updates links, hover preview with viewport prefetch. Daily use starts here: first release `v0.1.0` with auto-update (#12).
3. Search and Brain panel: `brain-adapter` with FTS5, excerpt cards with sources, usage events in `usage.jsonl` and edge weights (the last two are paused, #34).
4. Graph: `@myelin/graph` on WebGL2, layout worker, incremental API, semantic zoom, micro-animations, edge weights as thickness/glow.

## Decide later
Decide only when the stage that needs it starts.
- AI (after stage 4): semantic search (embedding model, must be multilingual; vector store), local model and runtime, syntheses and suggested links, how answers stay confined to the vault (retrieval + citations), where model files live (not bundled in the installer), and how to measure answer quality.
  - Quality set: 30-50 real questions with expected notes, covering: purely semantic (no shared words), literal terms/acronyms/names (hybrid must not lose what FTS5 gets right), mixed PT-BR + EN technical terms, and answers spread over 2-3 linked notes. Multi-note questions need "all expected notes in top k" (e.g. recall@5), not recall@3. With ~40 questions one miss is ~2.5 pts: only trust large differences.
- Obsidian vault compatibility (future option, not a goal now): link syntax stays a subset of Obsidian's (`[[Note]]`, `[[folder/Note]]`, `[[Note|alias]]`, #24); no Myelin-only link forms, so the option stays open.
- GitHub organization (before the first release, #12): moving the repo from `xrazai` to an org enables merge queue and a shared name, but installed apps' auto-update points at `owner/repo`. Move before `v0.1.0` or never; after releases it relies on GitHub redirects.
- Code signing (before sharing installers widely): Windows certificate or Azure Trusted Signing; macOS needs an Apple Developer account.
- npm scope `@myelin` (before publishing the library): no public packages under it (checked 2026-11-27), but whether a user/org already owns the name is unknown. Reserving means Rafa creating an npm org named `myelin`.

## Later
Millions/billions of nodes, spatial streaming, spatial index (quadtree or R*Tree), WebGPU backend and GPU compute layout, MSDF text in WebGL, edge bundling, Pro tier.

## Docs
- `docs/identity.md`: concept, palette (tokens), typography, icon. Single source for colors.
- `docs/features.md`: launcher, workspace, Brain panel, pillars A-D (editor, graph, backend, learning).
- `docs/graph-lib.md`: `@myelin/graph` rules, input buffers, API.
