// Animation-frame loop for offline screens (practice, replay viewer). Calls
// `onFrame(dtMs)` once per frame with the time since the previous frame (0 on
// the first). Errors stop the loop and go to `onError`.

export class FrameLoop {
  private running = false;
  private raf = 0;
  private last = -1;

  constructor(
    private readonly onFrame: (dtMs: number) => void,
    private readonly onError: (err: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Safe to call twice and from inside `onFrame`. */
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.last < 0 ? 0 : now - this.last;
    this.last = now;
    try {
      this.onFrame(dt);
    } catch (err) {
      this.stop();
      this.onError(err);
    }
  };
}
