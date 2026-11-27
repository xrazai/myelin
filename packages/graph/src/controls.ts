// Pan and zoom from the mouse, a trackpad and touch.
//
// Drag (mouse, pen or one finger) pans; two fingers pinch. A wheel event is one of:
//   zoom   with `ctrlKey`: a trackpad pinch (that is how browsers report it)
//   zoom   a mouse wheel notch: large steps, vertical only
//   pan    a two-finger trackpad scroll: sideways movement or small steps
// Browsers do not say which device scrolled, so the last two are told apart by the first
// event of a gesture, and the rest of the gesture keeps that answer.

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0: pixels, 1: lines, 2: pages. */
  deltaMode: number;
  ctrlKey: boolean;
  timeStamp: number;
}

export type WheelAction = { type: 'pan'; dx: number; dy: number } | { type: 'zoom'; factor: number };

/** A pause this long ends a scroll gesture. */
const GESTURE_GAP_MS = 200;
/** A vertical-only pixel step at least this large is a mouse wheel notch. */
const NOTCH_PIXELS = 40;
const LINE_PIXELS = 40;
const PAGE_PIXELS = 800;
const WHEEL_ZOOM_SPEED = 0.0015;
const PINCH_ZOOM_SPEED = 0.01;
/** Caps one pinch event, so that `Ctrl` + a mouse wheel does not jump. */
const MAX_PINCH_DELTA = 25;

export function createWheelReader(): (event: WheelInput) => WheelAction {
  let kind: 'pan' | 'zoom' = 'zoom';
  let last = -Infinity;
  return ({ deltaX, deltaY, deltaMode, ctrlKey, timeStamp }) => {
    const unit = deltaMode === 1 ? LINE_PIXELS : deltaMode === 2 ? PAGE_PIXELS : 1;
    if (ctrlKey) {
      const delta = Math.max(-MAX_PINCH_DELTA, Math.min(MAX_PINCH_DELTA, deltaY * unit));
      return { type: 'zoom', factor: Math.exp(-delta * PINCH_ZOOM_SPEED) };
    }
    if (timeStamp - last > GESTURE_GAP_MS) {
      kind = deltaMode === 0 && (deltaX !== 0 || Math.abs(deltaY) < NOTCH_PIXELS) ? 'pan' : 'zoom';
    }
    last = timeStamp;
    if (kind === 'pan') return { type: 'pan', dx: -deltaX * unit, dy: -deltaY * unit };
    return { type: 'zoom', factor: Math.exp(-deltaY * unit * WHEEL_ZOOM_SPEED) };
  };
}

export interface ControlHandlers {
  /** A screen distance in CSS pixels. */
  pan(dx: number, dy: number): void;
  /** `(x, y)`: CSS pixels from the canvas's top left corner. */
  zoom(x: number, y: number, factor: number): void;
}

/** Listens on the canvas; returns the function that stops listening. */
export function attachControls(canvas: HTMLCanvasElement, handlers: ControlHandlers): () => void {
  const readWheel = createWheelReader();
  /** Pointers that are down, in client coordinates. */
  const pointers = new Map<number, { x: number; y: number }>();
  const abort = new AbortController();
  const { signal } = abort;
  const previousTouchAction = canvas.style.touchAction;
  // Otherwise the browser scrolls or zooms the page instead.
  canvas.style.touchAction = 'none';

  const local = (x: number, y: number): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [x - box.left - canvas.clientLeft, y - box.top - canvas.clientTop];
  };

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const action = readWheel(event);
      if (action.type === 'pan') handlers.pan(action.dx, action.dy);
      else handlers.zoom(...local(event.clientX, event.clientY), action.factor);
    },
    { passive: false, signal },
  );

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      // Left and middle buttons; touch and pen report 0.
      if (event.button !== 0 && event.button !== 1) return;
      if (event.button === 1) event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    },
    { signal },
  );

  /** The center and spread of the first two pointers. */
  const pinch = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  };

  canvas.addEventListener(
    'pointermove',
    (event) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      const before = pointers.size >= 2 ? pinch() : null;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (!before) {
        handlers.pan(dx, dy);
        return;
      }
      const after = pinch();
      handlers.pan(after.x - before.x, after.y - before.y);
      if (before.distance > 0 && after.distance > 0) {
        handlers.zoom(...local(after.x, after.y), after.distance / before.distance);
      }
    },
    { signal },
  );

  const release = (event: PointerEvent) => void pointers.delete(event.pointerId);
  canvas.addEventListener('pointerup', release, { signal });
  canvas.addEventListener('pointercancel', release, { signal });
  canvas.addEventListener('lostpointercapture', release, { signal });

  return () => {
    abort.abort();
    pointers.clear();
    canvas.style.touchAction = previousTouchAction;
  };
}
