/**
 * Fixed-capacity LRU set. When capacity is exceeded the oldest entry is evicted.
 * Backed by a Map (which preserves insertion order) so oldest = first entry.
 */
export class LruSet<T> {
  private readonly capacity: number;
  private readonly store = new Map<T, true>();

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("capacity must be >= 1");
    this.capacity = capacity;
  }

  has(value: T): boolean {
    return this.store.has(value);
  }

  /** Returns true if the value was NOT already present (i.e. it was added). */
  add(value: T): boolean {
    if (this.store.has(value)) return false;
    if (this.store.size >= this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(value, true);
    return true;
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
