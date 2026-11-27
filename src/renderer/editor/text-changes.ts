// The changes that turn one text into another, small enough that the cursor, the scroll
// position and the undo history stay in place when a note is reloaded from disk.

export interface TextChange {
  /** Offsets in the old text. */
  from: number;
  to: number;
  insert: string;
}

/** Past this many differing lines, everything between the equal ends is one change. */
const MAX_EDITS = 1000;

/** Runs of lines that differ: `[oldFrom, oldTo, newFrom, newTo]`, in order (Myers). */
function lineRuns(a: string[], b: string[]): [number, number, number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  const whole: [number, number, number, number][] = [[start, endA, start, endB]];
  if (n === 0 || m === 0) return whole;

  const max = Math.min(n + m, MAX_EDITS);
  /** `trace[d]`: for each diagonal `k`, how far in `a` a path with `d` edits gets. */
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 3);
  const mid = max + 1;
  let edits = -1;
  for (let d = 0; d <= max && edits < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!);
      let x = down ? v[mid + k + 1]! : v[mid + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[mid + k] = x;
      if (x >= n && y >= m) {
        edits = d;
        break;
      }
    }
    trace.push(v.slice(mid - d, mid + d + 1));
  }
  if (edits < 0) return whole;

  // Walks the path back; each edit is one line removed from `a` or added from `b`.
  const runs: [number, number, number, number][] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const previous = trace[d - 1]!;
    const at = (k: number) => previous[k + d - 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const fromX = at(down ? k + 1 : k - 1);
    const fromY = fromX - (down ? k + 1 : k - 1);
    const run: [number, number, number, number] = down
      ? [start + fromX, start + fromX, start + fromY, start + fromY + 1]
      : [start + fromX, start + fromX + 1, start + fromY, start + fromY];
    const after = runs[0];
    if (after && run[1] === after[0] && run[3] === after[2]) {
      after[0] = run[0];
      after[2] = run[2];
    } else {
      runs.unshift(run);
    }
    x = fromX;
    y = fromY;
  }
  return runs;
}

/** Both texts use `\n`. The changes do not overlap and are in order. */
export function textChanges(from: string, to: string): TextChange[] {
  // Each line keeps its `\n`, so that offsets simply add up.
  const split = (text: string) => text.split(/(?<=\n)/);
  const a = split(from);
  const b = split(to);
  const offsets = [0];
  for (const line of a) offsets.push(offsets.at(-1)! + line.length);

  return lineRuns(a, b).map(([oldFrom, oldTo, newFrom, newTo]) => {
    const removed = from.slice(offsets[oldFrom], offsets[oldTo]);
    const added = b.slice(newFrom, newTo).join('');
    // Inside the lines, what is equal at both ends stays: a cursor there does not move.
    let head = 0;
    while (head < removed.length && head < added.length && removed[head] === added[head]) head++;
    let tail = 0;
    while (
      tail < removed.length - head &&
      tail < added.length - head &&
      removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
    ) {
      tail++;
    }
    return {
      from: offsets[oldFrom]! + head,
      to: offsets[oldTo]! - tail,
      insert: added.slice(head, added.length - tail),
    };
  });
}
