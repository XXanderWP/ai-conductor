/**
 * Soft daily request counters for configured provider instances.
 */

import type { UsageState, UsageStore } from '../config/types.js';

/** @deprecated Use {@link UsageState}. */
export type UsageSnapshot = UsageState;

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Default in-memory {@link UsageStore}. */
export class MemoryUsageStore implements UsageStore {
  private readonly usage = new Map<string, UsageState>();

  get(id: string): UsageState | undefined {
    return this.usage.get(id);
  }

  set(id: string, state: UsageState): void {
    this.usage.set(id, state);
  }

  delete(id: string): void {
    this.usage.delete(id);
  }

  clear(): void {
    this.usage.clear();
  }
}

/** Tracks per-instance request counts within a UTC day. */
export class DailyUsageTracker {
  private readonly store: UsageStore;
  private readonly known = new Set<string>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    store?: UsageStore,
  ) {
    this.store = store ?? new MemoryUsageStore();
  }

  getCount(providerId: string): number {
    const snap = this.store.get(providerId);
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
    const snap = this.store.get(providerId);
    this.known.add(providerId);
    this.store.set(providerId, {
      day,
      count: snap && snap.day === day ? snap.count + 1 : 1,
    });
  }

  /** Drop counters for instances that are no longer configured. */
  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      this.known.delete(id);
      this.store.delete?.(id);
    }
  }

  /** Test helper: reset all counters. */
  reset(): void {
    for (const id of this.known) this.store.delete?.(id);
    this.known.clear();
  }
}
