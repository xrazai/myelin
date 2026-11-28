// The graph's colors and label font, from the identity tokens (docs/identity.md). The
// constellations mix those tokens: no new base color.
import type { GraphViewOptions } from './graph-view';

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/** Halfway between two `#rrggbb` colors. */
export function mix(a: string, b: string): string {
  const other = channels(b);
  const half = channels(a).map((value, i) => Math.round((value + other[i]!) / 2));
  return `#${half.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function graphLook(
  tokens: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
): Pick<GraphViewOptions, 'colors' | 'labelStyle'> {
  const token = (name: string) => tokens.getPropertyValue(`--${name}`).trim().toLowerCase();
  const accent = token('accent');
  const learning = token('learning');
  const text = token('text');
  const muted = token('text-muted');
  return {
    colors: {
      background: token('bg-panel'),
      node: muted,
      activeNode: accent,
      edge: muted,
      strongEdge: accent,
      pulse: learning,
      constellations: [accent, learning, mix(accent, text), muted, mix(accent, learning), mix(learning, muted)],
    },
    labelStyle: { color: text, font: token('font-ui') },
  };
}
