// Widths of the workspace's side columns, in CSS pixels. The editor takes the rest.
// Renderer-only state, remembered per vault in `localStorage`.

export type Side = 'left' | 'right';
export type SideWidths = Record<Side, number>;
/**
 * The widths the user chose. `kept` is set when they do not fit the window they were chosen
 * in: the side resized last, which takes its room from the other one.
 */
export type PanelWidths = SideWidths & { kept?: Side };

export const DEFAULT_WIDTHS: Readonly<SideWidths> = { left: 260, right: 320 };
export const MIN_WIDTHS: Readonly<SideWidths> = { left: 160, right: 200 };
export const MIN_EDITOR_WIDTH = 320;
/** The two 1px dividers between the columns. */
const DIVIDERS = 2;

/** Room the two side columns may share in a window `total` wide. */
const sideRoom = (total: number) => total - MIN_EDITOR_WIDTH - DIVIDERS;

const otherSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');

/**
 * The widths to show in a window `total` wide: each side at least its minimum. When the
 * editor would get too narrow, the side that is not `kept` shrinks first; without `kept`,
 * both shrink in proportion to what they have above their minimum.
 */
export function fitWidths(widths: PanelWidths, total: number): SideWidths {
  const left = Math.max(MIN_WIDTHS.left, widths.left);
  const right = Math.max(MIN_WIDTHS.right, widths.right);
  const excess = left + right - sideRoom(total);
  const spare = left - MIN_WIDTHS.left + (right - MIN_WIDTHS.right);
  if (excess <= 0 || spare === 0) return { left, right };
  if (widths.kept) {
    const side = widths.kept;
    const other = otherSide(side);
    const fitted = { left, right };
    fitted[other] = Math.max(MIN_WIDTHS[other], fitted[other] - excess);
    fitted[side] = Math.max(MIN_WIDTHS[side], Math.min(fitted[side], sideRoom(total) - fitted[other]));
    return fitted;
  }
  const keep = Math.max(0, 1 - excess / spare);
  return {
    left: MIN_WIDTHS.left + Math.floor((left - MIN_WIDTHS.left) * keep),
    right: MIN_WIDTHS.right + Math.floor((right - MIN_WIDTHS.right) * keep),
  };
}

/** The widest `side` can be dragged: the other side stays as shown. */
export function maxWidth(shown: SideWidths, side: Side, total: number): number {
  return Math.max(MIN_WIDTHS[side], sideRoom(total) - shown[otherSide(side)]);
}

/** The widths after the user sets `side` to `width`, starting from what is on screen. */
export function resizeSide(shown: SideWidths, side: Side, width: number, total: number): SideWidths {
  const clamped = Math.min(maxWidth(shown, side, total), Math.max(MIN_WIDTHS[side], Math.round(width)));
  return { ...shown, [side]: clamped };
}

/** The widths to remember after the user chose `width` for `side`. The other side stays. */
export function chooseWidth(stored: PanelWidths, side: Side, width: number, total: number): PanelWidths {
  const chosen: SideWidths = { left: stored.left, right: stored.right, [side]: width };
  const fits = chosen.left + chosen.right <= sideRoom(total);
  return fits ? chosen : { ...chosen, kept: side };
}

/**
 * A resize by the user: on screen only `side` moves (`resizeSide`), and only its remembered
 * width changes. `shown` holds until the window width changes: a narrow window cannot
 * tell it from the remembered widths alone.
 */
export function resizeStored(stored: PanelWidths, shown: SideWidths, side: Side, width: number, total: number) {
  const next = resizeSide(shown, side, width, total);
  return { stored: chooseWidth(stored, side, next[side], total), shown: next };
}

const storageKey = (vaultId: string) => `myelin.layout.${vaultId}`;

const isWidth = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The remembered widths of a vault. Anything unreadable falls back to the default. */
export function loadWidths(storage: Pick<Storage, 'getItem'>, vaultId: string): PanelWidths {
  try {
    const stored = JSON.parse(storage.getItem(storageKey(vaultId)) ?? 'null') as Partial<PanelWidths> | null;
    const widths: PanelWidths = {
      left: isWidth(stored?.left) ? stored.left : DEFAULT_WIDTHS.left,
      right: isWidth(stored?.right) ? stored.right : DEFAULT_WIDTHS.right,
    };
    if (stored?.kept === 'left' || stored?.kept === 'right') widths.kept = stored.kept;
    return widths;
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
