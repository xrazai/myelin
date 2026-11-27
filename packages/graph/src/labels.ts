// Node titles on a Canvas 2D layer over the graph: at most about a hundred, by priority,
// skipping those that would overlap. The same camera and pixel ratio as the graph's frame.

import type { Frame } from './backend/backend.ts';
import { screenRadius, type HitStyle } from './hit-grid.ts';

export const MAX_LABELS = 100;
const FONT_PIXELS = 12;
const PADDING = 2;
/** Occupancy grid of the screen, in CSS pixels. */
const SLOT_WIDTH = 64;
const SLOT_HEIGHT = 16;

export interface LabelBox {
  id: number;
  text: string;
  /** CSS pixels: the label's center and top. */
  x: number;
  y: number;
  width: number;
}

export interface LabelInput {
  /** Node ids, the most important first. */
  order: ArrayLike<number>;
  positions: Float32Array;
  radii: Float32Array;
  /** Drawn first, whatever its rank: the hovered node. */
  first: number | null;
  frame: Frame;
  style: HitStyle;
  label: (id: number) => string;
  measure: (text: string) => number;
}

/** Which labels show, and where. `label` is only asked for nodes in view. */
export function placeLabels({ order, positions, radii, first, frame, style, label, measure }: LabelInput): LabelBox[] {
  const width = frame.width / frame.pixelRatio;
  const height = frame.height / frame.pixelRatio;
  const { camera } = frame;
  const taken = new Set<number>();
  const placed: LabelBox[] = [];

  const attempt = (id: number) => {
    const sx = (positions[id * 2]! - camera.x) * camera.zoom + width / 2;
    const sy = (positions[id * 2 + 1]! - camera.y) * camera.zoom + height / 2;
    // Not `sx < 0 || ...`: NaN (no node here) must fail too.
    if (!(sx >= 0 && sx <= width && sy >= 0 && sy <= height) || !(radii[id]! > 0)) return;
    const text = label(id);
    if (!text) return;
    const textWidth = measure(text);
    const top = sy + screenRadius(radii[id]!, camera.zoom, style) + PADDING;
    const slots: number[] = [];
    for (let row = Math.floor(top / SLOT_HEIGHT); row <= Math.floor((top + FONT_PIXELS) / SLOT_HEIGHT); row++) {
      const from = Math.floor((sx - textWidth / 2 - PADDING) / SLOT_WIDTH);
      const to = Math.floor((sx + textWidth / 2 + PADDING) / SLOT_WIDTH);
      for (let column = from; column <= to; column++) slots.push(row * 4096 + column);
    }
    if (slots.some((slot) => taken.has(slot))) return;
    for (const slot of slots) taken.add(slot);
    placed.push({ id, text, x: sx, y: top, width: textWidth });
  };

  if (first !== null) attempt(first);
  for (let i = 0; i < order.length && placed.length < MAX_LABELS; i++) {
    if (order[i] !== first) attempt(order[i]!);
  }
  return placed;
}

export interface LabelStyle {
  /** CSS color of the text. */
  color: string;
  /** CSS font family. */
  font: string;
}

export function drawLabels(
  context: CanvasRenderingContext2D,
  boxes: LabelBox[],
  frame: Frame,
  style: LabelStyle,
): void {
  context.setTransform(frame.pixelRatio, 0, 0, frame.pixelRatio, 0, 0);
  context.fillStyle = style.color;
  context.font = `${FONT_PIXELS}px ${style.font}`;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (const box of boxes) context.fillText(box.text, box.x, box.y);
}
