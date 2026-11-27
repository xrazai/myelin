# Myelin

A desktop app for a vault of Markdown notes that learns from how you write and navigate: fluid editor, GPU graph of your notes, and a Brain panel that answers from your own vault. Local-first and offline.

> Status: early development. The app is an empty window for now. Follow progress on the [project board](https://github.com/users/xrazai/projects/7).

## Development
Needs Node.js 22.12 or newer.

```
npm install
npm run dev
```

Checks: `npm run typecheck`, `npm test`, `npm run build`.

## Planned
- Fluid Markdown editor (CodeMirror 6) with live preview and `[[links]]`
- GPU graph (`@myelin/graph`, WebGL2), also published as a standalone open-source library
- Brain panel: search across your vault with excerpts and sources
- Myelination: links you use get stronger

Stack: Electron, TypeScript, Svelte 5, SQLite. Details in [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/).

## Contributing
Issues and PRs are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Security reports: [`SECURITY.md`](SECURITY.md).

## License
[MIT](LICENSE)
