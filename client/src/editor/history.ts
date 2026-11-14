// Undo/redo over immutable snapshots. A gesture calls `live` on every move and
// `settle` once at the end, so a drag is one undo step.

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private cur: T;
  /** The snapshot the pending gesture started from (what `settle` records). */
  private base: T;

  constructor(
    initial: T,
    private readonly limit = 200,
  ) {
    this.cur = initial;
    this.base = initial;
  }

  get present(): T {
    return this.cur;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Show `next` without recording it yet. */
  live(next: T): void {
    this.cur = next;
  }

  /** Record the change since the last settle, if any. */
  settle(): void {
    if (this.cur === this.base) return;
    this.past.push(this.base);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.base = this.cur;
  }

  /** Change and record in one step. */
  set(next: T): void {
    this.live(next);
    this.settle();
  }

  /** Drop all history and start over from `next`. */
  reset(next: T): void {
    this.past = [];
    this.future = [];
    this.cur = next;
    this.base = next;
  }

  undo(): boolean {
    this.settle();
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.cur);
    this.cur = prev;
    this.base = prev;
    return true;
  }

  redo(): boolean {
    this.settle();
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.cur);
    this.cur = next;
    this.base = next;
    return true;
  }
}
