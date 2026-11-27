// 2D camera math. Screen coordinates are CSS pixels from the canvas's top left corner;
// world y grows downward, like the screen's.

export interface Camera {
  /** World point at the center of the viewport. */
  x: number;
  y: number;
  /** CSS pixels per world unit. */
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export function screenToWorld(camera: Camera, size: Size, x: number, y: number): [number, number] {
  return [camera.x + (x - size.width / 2) / camera.zoom, camera.y + (y - size.height / 2) / camera.zoom];
}

/** Moves the picture by a screen distance: it follows the pointer. */
export function pan(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom, zoom: camera.zoom };
}

/** Scales the zoom; the world point under screen `(x, y)` stays there. */
export function zoomAt(camera: Camera, size: Size, x: number, y: number, factor: number, limits: ZoomLimits): Camera {
  const zoom = Math.min(limits.max, Math.max(limits.min, camera.zoom * factor));
  const [worldX, worldY] = screenToWorld(camera, size, x, y);
  return { x: worldX - (x - size.width / 2) / zoom, y: worldY - (y - size.height / 2) / zoom, zoom };
}

/** The bounds of `[x0, y0, ...]`; non-finite points are skipped. Null when none is left. */
export function boundsOf(positions: Float32Array): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

/** A single point, or very few close ones, is not magnified beyond this. */
const MAX_FIT_ZOOM = 1;

/** The camera that shows all of `bounds`, leaving `padding` (a share of the viewport) around. */
export function fit(bounds: Bounds, size: Size, padding = 0.05): Camera {
  const usable = 1 - 2 * padding;
  const zoom = Math.min(
    (size.width * usable) / (bounds.maxX - bounds.minX),
    (size.height * usable) / (bounds.maxY - bounds.minY),
    MAX_FIT_ZOOM,
  );
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom };
}
