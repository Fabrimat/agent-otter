/** Sliding-window limiter keyed by string: per IP (room creation), per room (messages), per WS connection. In-process only (ARCHITECTURE T-14). */
export class SlidingWindow {
  private hits = new Map<string, number[]>();
  private lastPrune = 0;
  constructor(private limit: number, private windowMs: number, private now: () => number) {}

  get size() { return this.hits.size; }

  /** True when the key is at its limit right now. Records nothing. */
  full(key: string): boolean {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs).length >= this.limit;
  }

  /** Records an attempt; false when the key is over the limit (the attempt is not counted then). */
  hit(key: string): boolean {
    const t = this.now();
    const live = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    const ok = live.length < this.limit;
    if (ok) live.push(t);
    if (live.length) this.hits.set(key, live);
    else this.hits.delete(key);
    // ponytail: full prune at most once a minute and only when the map is big: amortised O(1) per hit, no timer
    if (this.hits.size > 1000 && t - this.lastPrune >= 60_000) {
      this.lastPrune = t;
      for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
    }
    return ok;
  }
}
