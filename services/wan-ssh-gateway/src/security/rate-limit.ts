export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  allow(identity: string, now = Date.now()) {
    const recent = (this.hits.get(identity) ?? []).filter((stamp) => now - stamp < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(identity, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(identity, recent);
    return true;
  }

  reset() {
    this.hits.clear();
  }
}
