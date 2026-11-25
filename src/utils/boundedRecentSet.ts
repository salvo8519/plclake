/**
 * Memory-bounded "have I seen this key recently?" set for deduplication.
 *
 * Two generations: when the current one reaches `capacity`, it becomes the previous one and a
 * fresh set starts. Lookups check both, so the last `capacity`..`2 * capacity` keys are always
 * remembered. A plain `Set.clear()` at the limit forgets everything at once and lets every
 * recent duplicate through right after the reset.
 */
export class BoundedRecentSet {
  private current = new Set<string>();
  private previous = new Set<string>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('BoundedRecentSet capacity must be a positive integer.');
    }
  }

  has(key: string): boolean {
    return this.current.has(key) || this.previous.has(key);
  }

  add(key: string): void {
    if (this.current.has(key)) return;
    if (this.current.size >= this.capacity) {
      this.previous = this.current;
      this.current = new Set<string>();
    }
    this.current.add(key);
  }

  get size(): number {
    return this.current.size + this.previous.size;
  }
}
