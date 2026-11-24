/** A small time-based cache. `now` is injectable so tests can move the clock. */
export class TtlCache<K, V> {
  private readonly items = new Map<K, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: K): V | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.items.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    if (this.items.size >= this.maxSize) {
      const oldest = this.items.keys().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
    this.items.set(key, { value, expires: this.now() + ttlMs });
  }

  delete(key: K): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  /** Return the cached value or run `load` once and cache what it returns. */
  async getOrLoad(key: K, load: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    this.set(key, value, ttlMs);
    return value;
  }
}

/** Run `fn` over `items` with at most `limit` running at once, keeping the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
