// Node titles on a Canvas 2D layer over the graph: at most about a hundred, by priority,
// skipping those that would overlap. The same camera and pixel ratio as the graph's frame.

import type { Frame } from './backend/backend.ts';
import { screenRadius, type HitStyle } from './hit-grid.ts';

export const MAX_LABELS = 100;
const FONT_PIXELS = 12;
export const NAME_PIXELS = 15;
const MAX_NAMES = 40;
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
  /** A constellation's name, drawn larger; its `id` is the community's. */
  name?: boolean;
}

export interface LabelInput {
  /** Constellation names at world positions, the most important first; placed before nodes. */
  names?: { id: number; text: string; x: number; y: number }[];
  /** At most this many node labels. */
  max?: number;
  /** Measures a constellation name; `measure` when absent. */
  measureName?: (text: string) => number;
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
export function placeLabels(input: LabelInput): LabelBox[] {
  const { order, positions, radii, first, frame, style, label, measure } = input;
  const { names = [], max = MAX_LABELS, measureName = measure } = input;
  const width = frame.width / frame.pixelRatio;
  const height = frame.height / frame.pixelRatio;
  const { camera } = frame;
  const taken = new Set<number>();
  const placed: LabelBox[] = [];

  /** Takes the room of a text centered on `sx` whose top is `top`, if it is free. */
  const claim = (sx: number, top: number, textWidth: number, textHeight: number): boolean => {
    const slots: number[] = [];
    for (let row = Math.floor(top / SLOT_HEIGHT); row <= Math.floor((top + textHeight) / SLOT_HEIGHT); row++) {
      const from = Math.floor((sx - textWidth / 2 - PADDING) / SLOT_WIDTH);
      const to = Math.floor((sx + textWidth / 2 + PADDING) / SLOT_WIDTH);
      for (let column = from; column <= to; column++) slots.push(row * 4096 + column);
    }
    if (slots.some((slot) => taken.has(slot))) return false;
    for (const slot of slots) taken.add(slot);
    return true;
  };

  for (const name of names) {
    if (placed.length >= MAX_NAMES) break;
    const sx = (name.x - camera.x) * camera.zoom + width / 2;
    const sy = (name.y - camera.y) * camera.zoom + height / 2;
    if (!(sx >= 0 && sx <= width && sy >= 0 && sy <= height) || !name.text) continue;
    const textWidth = measureName(name.text);
    const top = sy - NAME_PIXELS / 2;
    if (claim(sx, top, textWidth, NAME_PIXELS)) {
      placed.push({ id: name.id, text: name.text, x: sx, y: top, width: textWidth, name: true });
    }
  }
  // The hovered node shows even where no other node is named.
  const limit = placed.length + Math.max(Math.min(max, MAX_LABELS), first === null ? 0 : 1);

  const attempt = (id: number) => {
    if (placed.length >= limit) return;
    const sx = (positions[id * 2]! - camera.x) * camera.zoom + width / 2;
    const sy = (positions[id * 2 + 1]! - camera.y) * camera.zoom + height / 2;
    // Not `sx < 0 || ...`: NaN (no node here) must fail too.
    if (!(sx >= 0 && sx <= width && sy >= 0 && sy <= height) || !(radii[id]! > 0)) return;
    const text = label(id);
    if (!text) return;
    const textWidth = measure(text);
    const top = sy + screenRadius(radii[id]!, camera.zoom, style) + PADDING;
    if (claim(sx, top, textWidth, FONT_PIXELS)) placed.push({ id, text, x: sx, y: top, width: textWidth });
  };

  if (first !== null) attempt(first);
  for (let i = 0; i < order.length && placed.length < limit; i++) {
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
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (const box of boxes) {
    context.font = `${box.name ? `600 ${NAME_PIXELS}` : FONT_PIXELS}px ${style.font}`;
    context.fillText(box.text, box.x, box.y);
  }
}
