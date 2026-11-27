// Barnes-Hut quadtree flattened into typed arrays, rebuilt on every layout step.
//
// Bodies are copied into `x`, `y`, `mass` and partitioned in place, so each cell owns the
// range [start, end) of that "tree order". Cells are stored in depth-first order: the first
// child of cell `i` is `i + 1`, and `next[i]` is the first cell after its whole subtree.
// A traversal therefore needs no stack. A cell is a leaf when `next[i] === i + 1`.
// A chain of cells with a single child is collapsed, so there are fewer than 2n cells.

/** Bodies a leaf holds before it is split. */
const LEAF_SIZE = 8;
/** Stops the splitting of (nearly) coincident bodies. */
const MAX_DEPTH = 48;

export class QuadTree {
  /** Tree order -> body index. Kept between builds: bodies move little, so it stays coherent. */
  readonly order: Int32Array;
  /** Bodies in tree order. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly mass: Float32Array;

  cellCount = 0;
  /** Center of mass. */
  readonly cellX: Float32Array;
  readonly cellY: Float32Array;
  readonly cellMass: Float32Array;
  /** Width of the cell's square. */
  readonly cellSize: Float32Array;
  readonly start: Int32Array;
  readonly end: Int32Array;
  readonly next: Int32Array;

  constructor(count: number) {
    this.order = new Int32Array(count);
    for (let i = 0; i < count; i++) this.order[i] = i;
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.mass = new Float32Array(count);
    const cells = Math.max(1, count * 2);
    this.cellX = new Float32Array(cells);
    this.cellY = new Float32Array(cells);
    this.cellMass = new Float32Array(cells);
    this.cellSize = new Float32Array(cells);
    this.start = new Int32Array(cells);
    this.end = new Int32Array(cells);
    this.next = new Int32Array(cells);
  }

  /** `positions` is `[x0, y0, x1, y1, ...]`; `masses` is indexed by body. */
  build(positions: Float32Array, masses: Float32Array): void {
    const { order, x, y, mass } = this;
    const count = order.length;
    this.cellCount = 0;
    if (count === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < count; k++) {
      const body = order[k]!;
      const px = positions[body * 2]!;
      const py = positions[body * 2 + 1]!;
      x[k] = px;
      y[k] = py;
      mass[k] = masses[body]!;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    this.split(0, count, minX, minY, Math.max(maxX - minX, maxY - minY, 1e-3), 0);
  }

  /** Moves the bodies of [from, to) with `axis < middle` to the front; returns where they end. */
  private partition(axis: Float32Array, from: number, to: number, middle: number): number {
    const { order, x, y, mass } = this;
    let low = from;
    let high = to - 1;
    while (low <= high) {
      if (axis[low]! < middle) {
        low++;
        continue;
      }
      const body = order[low]!;
      const bx = x[low]!;
      const by = y[low]!;
      const bm = mass[low]!;
      order[low] = order[high]!;
      x[low] = x[high]!;
      y[low] = y[high]!;
      mass[low] = mass[high]!;
      order[high] = body;
      x[high] = bx;
      y[high] = by;
      mass[high] = bm;
      high--;
    }
    return low;
  }

  private split(from: number, to: number, left: number, top: number, size: number, depth: number): void {
    while (to - from > LEAF_SIZE && depth < MAX_DEPTH) {
      const half = size / 2;
      const midX = left + half;
      const midY = top + half;
      const lower = this.partition(this.y, from, to, midY);
      const upperLeft = this.partition(this.x, from, lower, midX);
      const lowerLeft = this.partition(this.x, lower, to, midX);
      const bounds = [from, upperLeft, lower, lowerLeft, to];
      let only = -1;
      for (let q = 0; q < 4; q++) {
        if (bounds[q + 1]! - bounds[q]! === to - from) only = q;
      }
      if (only >= 0) {
        // Everything is in one quadrant: shrink to it instead of adding a cell.
        if (only & 1) left = midX;
        if (only & 2) top = midY;
        size = half;
        depth++;
        continue;
      }
      const cell = this.cellCount++;
      let total = 0;
      let sumX = 0;
      let sumY = 0;
      for (let q = 0; q < 4; q++) {
        if (bounds[q + 1] === bounds[q]) continue;
        const child = this.cellCount;
        this.split(bounds[q]!, bounds[q + 1]!, q & 1 ? midX : left, q & 2 ? midY : top, half, depth + 1);
        const childMass = this.cellMass[child]!;
        total += childMass;
        sumX += this.cellX[child]! * childMass;
        sumY += this.cellY[child]! * childMass;
      }
      this.close(cell, from, to, size, total, sumX, sumY);
      return;
    }
    const cell = this.cellCount++;
    let total = 0;
    let sumX = 0;
    let sumY = 0;
    for (let k = from; k < to; k++) {
      const m = this.mass[k]!;
      total += m;
      sumX += this.x[k]! * m;
      sumY += this.y[k]! * m;
    }
    this.close(cell, from, to, size, total, sumX, sumY);
  }

  private close(cell: number, from: number, to: number, size: number, total: number, sumX: number, sumY: number): void {
    this.cellX[cell] = sumX / total;
    this.cellY[cell] = sumY / total;
    this.cellMass[cell] = total;
    this.cellSize[cell] = size;
    this.start[cell] = from;
    this.end[cell] = to;
    this.next[cell] = this.cellCount;
  }

  /**
   * Writes into `out` (`[fx0, fy0, ...]`, by body) the repulsion on every body:
   * magnitude `scaling * mass_a * mass_b / distance`. A cell is taken as one body when
   * `size / distance < theta`; `theta = 0` computes every pair.
   */
  repulsion(out: Float32Array, scaling: number, theta: number): void {
    const { order, x, y, mass, cellX, cellY, cellMass, cellSize, start, end, next, cellCount } = this;
    const theta2 = theta * theta;
    for (let k = 0; k < order.length; k++) {
      const px = x[k]!;
      const py = y[k]!;
      const own = scaling * mass[k]!;
      let fx = 0;
      let fy = 0;
      let cell = 0;
      while (cell < cellCount) {
        const from = start[cell]!;
        const to = end[cell]!;
        // A cell that holds the body is never approximated: it would push itself.
        if (k < from || k >= to) {
          const dx = px - cellX[cell]!;
          const dy = py - cellY[cell]!;
          const d2 = dx * dx + dy * dy;
          const width = cellSize[cell]!;
          if (width * width < theta2 * d2) {
            const factor = (own * cellMass[cell]!) / d2;
            fx += dx * factor;
            fy += dy * factor;
            cell = next[cell]!;
            continue;
          }
        }
        if (next[cell] === cell + 1) {
          for (let j = from; j < to; j++) {
            if (j === k) continue;
            let dx = px - x[j]!;
            const dy = py - y[j]!;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1e-6) {
              // Coincident bodies have no direction: push them apart along x.
              dx = k < j ? -1e-3 : 1e-3;
              d2 = 1e-6;
            }
            const factor = (own * mass[j]!) / d2;
            fx += dx * factor;
            fy += dy * factor;
          }
        }
        cell++;
      }
      const body = order[k]!;
      out[body * 2] = fx;
      out[body * 2 + 1] = fy;
    }
  }
}
