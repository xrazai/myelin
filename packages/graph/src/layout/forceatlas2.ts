// ForceAtlas2 (Jacomy et al., PLoS ONE 2014, doi:10.1371/journal.pone.0098679) in LinLog
// mode, with Barnes-Hut repulsion. Plain computation: no DOM and no worker APIs.
//
//   repulsion   scalingRatio * (deg_a + 1) * (deg_b + 1) / distance
//   attraction  weight * log(1 + distance)   (linLog) or weight * distance, along each edge
//   gravity     gravity * (deg + 1), toward the origin: constant, but linear near it
//
// The step size adapts to swing (a node's force changing) and traction (it persisting).
// Beyond the paper: that softened gravity, cooling once the movement stops improving, and
// no minimum of iterations for a graph with every position saved.

import { QuadTree } from './quadtree.ts';
import { mulberry32 } from './random.ts';

export interface LayoutOptions {
  /** Repulsion strength: larger spreads the graph. */
  scalingRatio?: number;
  gravity?: number;
  /** Logarithmic attraction: tighter clusters, clearer from afar. */
  linLog?: boolean;
  /** Barnes-Hut accuracy: 0 computes every pair; larger is faster and rougher. */
  theta?: number;
  /** Attraction uses `weight ** edgeWeightInfluence`; 0 ignores weights. */
  edgeWeightInfluence?: number;
  /** How much swing is accepted for speed. */
  jitterTolerance?: number;
  /** Seed of the initial positions: same graph and seed, same picture. */
  seed?: number;
  /** The layout settles when the mean movement of a step, relative to its size, stays under this. */
  stopThreshold?: number;
  maxIterations?: number;
}

export interface LayoutGraph {
  nodeCount: number;
  /** `[source0, target0, source1, target1, ...]` */
  edges: Uint32Array;
  /** One per edge; 1 when absent. */
  weights?: Float32Array;
  /** `[x0, y0, ...]` to start from. A node with a non-finite coordinate gets a seeded one. */
  positions?: Float32Array;
}

export const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  scalingRatio: 2,
  gravity: 1,
  linLog: true,
  theta: 1.2,
  edgeWeightInfluence: 1,
  jitterTolerance: 1,
  seed: 1,
  stopThreshold: 5e-4,
  maxIterations: 2000,
};

/**
 * No early stop before this: the speed starts low, which looks like rest. Not for a graph
 * with every position saved, so that reopening it barely moves it; one saved half-way still
 * moves too much to settle at once.
 */
const MIN_ITERATIONS = 50;
/** Gravity is linear within this times `sqrt(nodeCount)` of the center. */
const GRAVITY_SOFTENING = 10;
/** Consecutive quiet steps needed to settle. */
const QUIET_STEPS = 10;
/**
 * Some shapes (a huge star, no edges) keep trembling at full speed after they take shape.
 * Once the movement has not improved by a tenth for this many steps, it cools down.
 */
const PATIENCE = 200;
const COOLING = 0.98;

/** Throws on input that would otherwise fail far from its cause. */
export function checkGraph({ nodeCount, edges, weights, positions }: LayoutGraph): void {
  if (!Number.isInteger(nodeCount) || nodeCount < 0) throw new RangeError('nodeCount must be an integer >= 0');
  if (edges.length % 2 !== 0) throw new RangeError('edges must hold pairs');
  for (let i = 0; i < edges.length; i++) {
    if (edges[i]! >= nodeCount) throw new RangeError(`edge ${i >> 1} points to node ${edges[i]} of ${nodeCount}`);
  }
  if (weights && weights.length !== edges.length / 2) throw new RangeError('weights must hold one value per edge');
  if (positions && positions.length !== nodeCount * 2) throw new RangeError('positions must hold two values per node');
}

export class ForceAtlas2 {
  readonly options: Required<LayoutOptions>;
  readonly nodeCount: number;
  /** All per node, `[x0, y0, x1, y1, ...]`. */
  readonly positions: Float32Array;
  /** Movement of the last step. */
  readonly velocities: Float32Array;
  readonly forces: Float32Array;
  private readonly previousForces: Float32Array;
  /** `degree + 1`. */
  private readonly masses: Float32Array;
  private readonly edges: Uint32Array;
  /** Weight of each edge after `edgeWeightInfluence`. */
  private readonly strengths: Float32Array;
  private readonly tree: QuadTree;
  private minIterations = MIN_ITERATIONS;
  private speed = 1;
  private speedEfficiency = 1;
  private quiet = 0;
  private temperature = 1;
  private best = Infinity;
  private stale = 0;

  iteration = 0;
  /** Mean movement of the last step divided by the mean distance to the center of the layout. */
  movement = Infinity;
  /** Settled before reaching `maxIterations`. */
  converged = false;
  done = false;

  constructor(graph: LayoutGraph, options: LayoutOptions = {}) {
    checkGraph(graph);
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const { nodeCount, edges, weights } = graph;
    this.nodeCount = nodeCount;
    this.edges = edges;
    this.positions = new Float32Array(nodeCount * 2);
    this.velocities = new Float32Array(nodeCount * 2);
    this.forces = new Float32Array(nodeCount * 2);
    this.previousForces = new Float32Array(nodeCount * 2);
    this.masses = new Float32Array(nodeCount).fill(1);
    this.strengths = new Float32Array(edges.length / 2);
    const influence = this.options.edgeWeightInfluence;
    for (let e = 0; e < this.strengths.length; e++) {
      const source = edges[e * 2]!;
      const target = edges[e * 2 + 1]!;
      // A self-loop pulls nothing.
      if (source === target) continue;
      this.masses[source]!++;
      this.masses[target]!++;
      const weight = weights ? weights[e]! : 1;
      this.strengths[e] = weight > 0 && weight < Infinity ? weight ** influence : 0;
    }
    this.place(graph.positions);
    this.tree = new QuadTree(nodeCount);
    this.done = nodeCount === 0;
    this.converged = this.done;
  }

  private place(saved: Float32Array | undefined): void {
    const { positions, nodeCount } = this;
    const random = mulberry32(this.options.seed);
    // About the size the settled layout has, so that it neither explodes nor collapses first.
    const radius = 10 * Math.sqrt(nodeCount);
    let missing = 0;
    for (let i = 0; i < nodeCount; i++) {
      const distance = radius * Math.sqrt(random());
      const angle = 2 * Math.PI * random();
      const x = saved?.[i * 2] ?? NaN;
      const y = saved?.[i * 2 + 1] ?? NaN;
      const known = Number.isFinite(x) && Number.isFinite(y);
      if (!known) missing++;
      positions[i * 2] = known ? x : distance * Math.cos(angle);
      positions[i * 2 + 1] = known ? y : distance * Math.sin(angle);
    }
    if (saved) this.separate(random);
    if (missing === 0) this.minIterations = 0;
  }

  /** Nodes saved on the same point (an unfilled buffer, say) would make the tree quadratic. */
  private separate(random: () => number): void {
    const { positions } = this;
    const sorted = Array.from({ length: this.nodeCount }, (_, i) => i).sort(
      (a, b) => positions[a * 2]! - positions[b * 2]! || positions[a * 2 + 1]! - positions[b * 2 + 1]! || a - b,
    );
    let x = NaN;
    let y = NaN;
    for (const node of sorted) {
      if (positions[node * 2] === x && positions[node * 2 + 1] === y) {
        const spread = 1 + Math.abs(x) * 1e-5 + Math.abs(y) * 1e-5;
        positions[node * 2] = x + (random() - 0.5) * spread;
        positions[node * 2 + 1] = y + (random() - 0.5) * spread;
      } else {
        x = positions[node * 2]!;
        y = positions[node * 2 + 1]!;
      }
    }
  }

  private computeForces(): void {
    const { positions, forces, masses, edges, strengths, nodeCount } = this;
    const { scalingRatio, theta, gravity, linLog } = this.options;
    this.tree.build(positions, masses);
    this.tree.repulsion(forces, scalingRatio, theta);

    for (let e = 0; e < strengths.length; e++) {
      const strength = strengths[e]!;
      if (strength === 0) continue;
      const source = edges[e * 2]! * 2;
      const target = edges[e * 2 + 1]! * 2;
      const dx = positions[target]! - positions[source]!;
      const dy = positions[target + 1]! - positions[source + 1]!;
      let factor = strength;
      if (linLog) {
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance === 0) continue;
        factor *= Math.log1p(distance) / distance;
      }
      forces[source]! += dx * factor;
      forces[source + 1]! += dy * factor;
      forces[target]! -= dx * factor;
      forces[target + 1]! -= dy * factor;
    }

    const softening = GRAVITY_SOFTENING * Math.sqrt(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const x = positions[i * 2]!;
      const y = positions[i * 2 + 1]!;
      const distance = Math.sqrt(x * x + y * y);
      // Constant pull, but linear near the center: a pull that flips at the origin would keep
      // a hub resting there swinging, which slows every node down until the layout freezes.
      const factor = (gravity * masses[i]!) / Math.max(distance, softening);
      forces[i * 2]! -= x * factor;
      forces[i * 2 + 1]! -= y * factor;
    }
  }

  /** The global speed: fast while forces persist, slower when nodes swing back and forth. */
  private adaptSpeed(swing: number, traction: number): void {
    const count = this.nodeCount;
    // Larger graphs, and graphs far from rest, tolerate more swing.
    const estimate = 0.05 * Math.sqrt(count);
    let tolerance =
      this.options.jitterTolerance *
      Math.max(Math.sqrt(estimate), Math.min(10, (estimate * traction) / (count * count)));
    if (swing > 2 * traction) {
      if (this.speedEfficiency > 0.05) this.speedEfficiency *= 0.5;
      tolerance = Math.max(tolerance, this.options.jitterTolerance);
    }
    const target = swing === 0 ? Infinity : (tolerance * this.speedEfficiency * traction) / swing;
    if (swing > tolerance * traction) {
      if (this.speedEfficiency > 0.05) this.speedEfficiency *= 0.7;
    } else if (this.speed < 1000) {
      this.speedEfficiency *= 1.3;
    }
    // It rises by at most 50% a step; it may fall at once.
    this.speed += Math.min(target - this.speed, 0.5 * this.speed);
  }

  private cool(): void {
    if (this.temperature === 1) {
      if (this.movement < 0.9 * this.best) {
        this.best = this.movement;
        this.stale = 0;
        return;
      }
      if (++this.stale < PATIENCE) return;
    }
    this.temperature *= COOLING;
  }

  /** One iteration. Does nothing once `done`. */
  step(): void {
    if (this.done) return;
    const { positions, velocities, forces, previousForces, masses, nodeCount } = this;
    previousForces.set(forces);
    this.computeForces();

    let swing = 0;
    let traction = 0;
    for (let i = 0; i < nodeCount * 2; i += 2) {
      const mass = masses[i / 2]!;
      swing += mass * Math.hypot(forces[i]! - previousForces[i]!, forces[i + 1]! - previousForces[i + 1]!);
      traction += (mass * Math.hypot(forces[i]! + previousForces[i]!, forces[i + 1]! + previousForces[i + 1]!)) / 2;
    }
    this.adaptSpeed(swing, traction);

    let moved = 0;
    let centerX = 0;
    let centerY = 0;
    for (let i = 0; i < nodeCount * 2; i += 2) {
      const fx = forces[i]!;
      const fy = forces[i + 1]!;
      const dfx = fx - previousForces[i]!;
      const dfy = fy - previousForces[i + 1]!;
      const nodeSwing = masses[i / 2]! * Math.sqrt(dfx * dfx + dfy * dfy);
      const factor = (this.temperature * this.speed) / (1 + Math.sqrt(this.speed * nodeSwing));
      const dx = fx * factor;
      const dy = fy * factor;
      velocities[i] = dx;
      velocities[i + 1] = dy;
      positions[i]! += dx;
      positions[i + 1]! += dy;
      moved += Math.sqrt(dx * dx + dy * dy);
      centerX += positions[i]!;
      centerY += positions[i + 1]!;
    }
    centerX /= nodeCount;
    centerY /= nodeCount;
    let spread = 0;
    for (let i = 0; i < nodeCount * 2; i += 2) {
      spread += Math.hypot(positions[i]! - centerX, positions[i + 1]! - centerY);
    }
    // A single node has no size: measure its movement in layout units.
    this.movement = moved / Math.max(spread, nodeCount);

    this.iteration++;
    this.cool();
    this.quiet = this.movement < this.options.stopThreshold ? this.quiet + 1 : 0;
    this.converged = this.iteration >= this.minIterations && this.quiet >= QUIET_STEPS;
    this.done = this.converged || this.iteration >= this.options.maxIterations;
  }
}
