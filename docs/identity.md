# Visual identity: "Nocturnal Botany"

## Name
Myelin: after myelin, the sheath that strengthens and speeds up frequently used neural connections.

## Concept
The vault is a living, growing organism, not cold tech software.
- Silence, deep focus, a natural feel for long writing sessions.
- Avoid: purples, neons, generic "tech" look.

## Palette (organic dark mode)

| Token | Hex | Use |
|---|---|---|
| `bg-editor` | `#111615` | Writing area. Deep slate with a forest-green undertone. |
| `bg-panel` | `#0B0F0E` | Side panels (tree, graph / Brain panel). No heavy borders. |
| `divider` | `#1E2926` | Subtle dividers between panels, always `1px`. Not enough alone to outline inputs. |
| `accent` | `#52B788` | Bioluminescent sage green: synapses, `[[note]]` links, active graph nodes, selections, active model reply. |
| `learning` | `#F3E9D2` | Warm ivory: activity/learning pulse. Now: synaptic pulse on a new `[[link]]`, status bar activity (indexing, weight updates), local-source footer of the Brain panel. Later: model digesting a note. |
| `text` | `#E2E8E5` | Primary text (soft mineral white). |
| `text-muted` | `#8A9992` | Secondary text. |

Inputs (Brain panel search, `Ctrl+P`): filled with `bg-editor` on top of `bg-panel`, so the shape reads without relying on the `1px` divider. Focus: `1px` `accent` border/ring. No new colors.

## Typography
| Role | Family | Notes |
|---|---|---|
| Writing / reading body | Literata or Newsreader (serif) | "Field notebook" feel, not generic SaaS. 17-18 px. Pick by visual test on `#111615`. |
| UI (menus, tree, Brain panel) | Inter | Legible at 12-13 px. Tabular numbers via `font-feature-settings: "tnum"`. |
| Code, raw Markdown syntax, metadata | JetBrains Mono | |

- Body candidates on dark backgrounds:
  - Literata: built for long screen reading, larger x-height, more even stroke contrast; less halation (light text "blooming" on dark).
  - Newsreader: more editorial personality and an expressive italic, fits the identity; higher thick/thin contrast may need variable weight ~420-450.
  - Both have an optical size axis: keep `font-optical-sizing: auto`.
- `[[links]]` use the body font in `accent` color, not mono. Mono shows only the raw syntax when the cursor is on the line.
- Fonts are bundled in the app (offline), variable versions, all OFL.

## Icon
Minimal cellular/botanical structure: a leaf vein turning into a synapse. `#52B788` on a dark background.
