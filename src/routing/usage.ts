/**
 * Soft daily request counters for configured providers.
 */

export interface UsageSnapshot {
  /** UTC day key `YYYY-MM-DD`. */
  day: string;
  count: number;
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Tracks per-provider request counts within a UTC day. */
export class DailyUsageTracker {
  private readonly usage = new Map<string, UsageSnapshot>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  getCount(providerId: string): number {
    const snap = this.usage.get(providerId);
    if (!snap) return 0;
    const day = utcDayKey(this.now());
    return snap.day === day ? snap.count : 0;
  }

  isExhausted(providerId: string, dailyLimit?: number): boolean {
    if (dailyLimit == null || dailyLimit <= 0) return false;
    return this.getCount(providerId) >= dailyLimit;
  }

  record(providerId: string): void {
    const day = utcDayKey(this.now());
    const snap = this.usage.get(providerId);
    if (!snap || snap.day !== day) {
      this.usage.set(providerId, { day, count: 1 });
      return;
    }
    snap.count += 1;
  }

  /** Test helper: reset all counters. */
  reset(): void {
    this.usage.clear();
  }
}
