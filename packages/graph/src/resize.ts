// Reports the canvas's size in CSS and device pixels, on layout and `devicePixelRatio`
// changes. The page must give the canvas a CSS size: the backing size set from this report
// would otherwise change the canvas's own layout size.

export interface CanvasSize {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Backing store, in device pixels. */
  pixelWidth: number;
  pixelHeight: number;
}

/** Returns the function that stops observing. The first report comes before the next paint. */
export function observeCanvasSize(canvas: HTMLCanvasElement, report: (size: CanvasSize) => void): () => void {
  let media: MediaQueryList | null = null;

  const emit = (entry: ResizeObserverEntry) => {
    const { width, height } = entry.contentRect;
    // Exact where it exists (Chromium, Firefox); rounding may miss by a pixel elsewhere.
    const exact = entry.devicePixelContentBoxSize?.[0];
    report({
      width,
      height,
      pixelWidth: exact ? exact.inlineSize : Math.round(width * devicePixelRatio),
      pixelHeight: exact ? exact.blockSize : Math.round(height * devicePixelRatio),
    });
  };
  const observer = new ResizeObserver((entries) => emit(entries.at(-1)!));
  const observe = () => {
    observer.disconnect();
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(canvas);
    }
  };

  // A new ratio (another monitor, browser zoom) may leave the CSS size as it was, which
  // some browsers do not report. A media query matches one ratio only: renew it each time.
  const onRatioChange = () => {
    watchRatio();
    observe();
  };
  const watchRatio = () => {
    media?.removeEventListener('change', onRatioChange);
    media = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    media.addEventListener('change', onRatioChange);
  };

  watchRatio();
  observe();
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onRatioChange);
  };
}
