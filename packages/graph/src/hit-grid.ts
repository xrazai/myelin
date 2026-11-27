// Which node is under the pointer: a hash grid over world positions. Large nodes (hubs)
// are few and kept apart, so that a query reaches only the cells right around the point.

/** Nodes this many times the base radius or larger are checked one by one. */
const LARGE = 3;
/** Extra reach around a node, in CSS pixels: tiny nodes can still be pointed at. */
const SLOP = 4;
/** A query never walks more cells than this on each side. */
const MAX_REACH = 12;

export interface HitStyle {
  /** World radius that `minNodeRadius` refers to. */
  nodeRadius: number;
  /** CSS pixels. */
  minNodeRadius: number;
  maxNodeRadius: number;
}

/** The radius a node is drawn with, in CSS pixels (as the node shader does it). */
export function screenRadius(radius: number, zoom: number, style: HitStyle): number {
  const floor = style.minNodeRadius * Math.sqrt(radius / style.nodeRadius);
  return Math.min(style.maxNodeRadius, Math.max(floor, radius * zoom));
}

export class HitGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly large: number[] = [];
  private size = 1;
  private smallest = 0;
  private positions: Float32Array = new Float32Array(0);
  private radii: Float32Array = new Float32Array(0);

  private readonly style: HitStyle;

  constructor(style: HitStyle) {
    this.style = style;
  }

  /** `positions` `[x0, y0, ...]`, NaN or radius 0 for no node. The arrays are kept, not copied. */
  build(positions: Float32Array, radii: Float32Array, count: number): void {
    this.positions = positions;
    this.radii = radii;
    this.cells.clear();
    this.large.length = 0;
    this.size = this.style.nodeRadius * LARGE * 2;
    this.smallest = this.style.nodeRadius;
    for (let id = 0; id < count; id++) {
      const x = positions[id * 2]!;
      const y = positions[id * 2 + 1]!;
      if (!(radii[id]! > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (radii[id]! >= this.style.nodeRadius * LARGE) {
        this.large.push(id);
        continue;
      }
      const key = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
      const cell = this.cells.get(key);
      if (cell) cell.push(id);
      else this.cells.set(key, [id]);
    }
  }

  private key(cx: number, cy: number): number {
    // Distinct for any cell within 2^20 of the origin on each side.
    return (cx + 1048576) * 2097152 + (cy + 1048576);
  }

  /** The node at world point `(x, y)` seen at `zoom`, the nearest to it; `null` for none. */
  at(x: number, y: number, zoom: number): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    const consider = (id: number) => {
      const dx = this.positions[id * 2]! - x;
      const dy = this.positions[id * 2 + 1]! - y;
      const distance = Math.sqrt(dx * dx + dy * dy) * zoom;
      if (distance <= screenRadius(this.radii[id]!, zoom, this.style) + SLOP && distance < bestDistance) {
        best = id;
        bestDistance = distance;
      }
    };
    for (const id of this.large) consider(id);
    // How far, in cells, a small node can be and still reach the point.
    const widest = screenRadius(this.smallest * LARGE, zoom, this.style) + SLOP;
    const reach = Math.min(MAX_REACH, Math.ceil(widest / zoom / this.size));
    const cx = Math.floor(x / this.size);
    const cy = Math.floor(y / this.size);
    for (let i = -reach; i <= reach; i++) {
      for (let j = -reach; j <= reach; j++) {
        const cell = this.cells.get(this.key(cx + i, cy + j));
        if (cell) for (const id of cell) consider(id);
      }
    }
    return best;
  }
}
