// Widths of the workspace's side columns, in CSS pixels. The editor takes the rest.
// Renderer-only state, remembered per vault in `localStorage`.

export type Side = 'left' | 'right';
export type PanelWidths = Record<Side, number>;

export const DEFAULT_WIDTHS: Readonly<PanelWidths> = { left: 260, right: 320 };
export const MIN_WIDTHS: Readonly<PanelWidths> = { left: 160, right: 200 };
export const MIN_EDITOR_WIDTH = 320;
/** The two 1px dividers between the columns. */
const DIVIDERS = 2;

/** Room the two side columns may share in a window `total` wide. */
const sideRoom = (total: number) => total - MIN_EDITOR_WIDTH - DIVIDERS;

/**
 * The widths to show in a window `total` wide: each side at least its minimum, both shrunk
 * in proportion to what they have above it when the editor would get too narrow.
 */
export function fitWidths(widths: PanelWidths, total: number): PanelWidths {
  const left = Math.max(MIN_WIDTHS.left, widths.left);
  const right = Math.max(MIN_WIDTHS.right, widths.right);
  const excess = left + right - sideRoom(total);
  const spare = left - MIN_WIDTHS.left + (right - MIN_WIDTHS.right);
  if (excess <= 0 || spare === 0) return { left, right };
  const keep = Math.max(0, 1 - excess / spare);
  return {
    left: MIN_WIDTHS.left + Math.floor((left - MIN_WIDTHS.left) * keep),
    right: MIN_WIDTHS.right + Math.floor((right - MIN_WIDTHS.right) * keep),
  };
}

/** The widest `side` can be dragged: the other side stays as shown. */
export function maxWidth(shown: PanelWidths, side: Side, total: number): number {
  const other = side === 'left' ? shown.right : shown.left;
  return Math.max(MIN_WIDTHS[side], sideRoom(total) - other);
}

/** The widths after the user sets `side` to `width`, starting from what is on screen. */
export function resizeSide(shown: PanelWidths, side: Side, width: number, total: number): PanelWidths {
  const clamped = Math.min(maxWidth(shown, side, total), Math.max(MIN_WIDTHS[side], Math.round(width)));
  return { ...shown, [side]: clamped };
}

const storageKey = (vaultId: string) => `myelin.layout.${vaultId}`;

const isWidth = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The remembered widths of a vault. Anything unreadable falls back to the default. */
export function loadWidths(storage: Pick<Storage, 'getItem'>, vaultId: string): PanelWidths {
  try {
    const stored = JSON.parse(storage.getItem(storageKey(vaultId)) ?? 'null') as Partial<PanelWidths> | null;
    return {
      left: isWidth(stored?.left) ? stored.left : DEFAULT_WIDTHS.left,
      right: isWidth(stored?.right) ? stored.right : DEFAULT_WIDTHS.right,
    };
  } catch {
    return { ...DEFAULT_WIDTHS };
  }
}

export function saveWidths(storage: Pick<Storage, 'setItem'>, vaultId: string, widths: PanelWidths): void {
  try {
    storage.setItem(storageKey(vaultId), JSON.stringify(widths));
  } catch {
    // A full or blocked storage only loses the sizes.
  }
}
