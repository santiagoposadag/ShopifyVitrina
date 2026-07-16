/**
 * In-memory rate limiting for the public-facing agent. WhatsApp is an open
 * inbox: anyone who has the number can trigger paid model turns, so customer
 * turns are capped per phone (sliding hour window) with a global daily cap as
 * a circuit breaker. In-memory is deliberate — single-process deployment, and
 * counters resetting on restart is acceptable for the pilot.
 */

const HOUR_MS = 60 * 60 * 1000;

export type RateDecision = "ok" | "phone_limited" | "global_limited";

export interface RateLimiterOptions {
  perPhonePerHour: number;
  globalPerDay: number;
}

export class RateLimiter {
  private readonly perPhone = new Map<string, number[]>();
  private readonly noticeSentAt = new Map<string, number>();
  private dayKey = "";
  private dayCount = 0;

  constructor(private readonly options: RateLimiterOptions) {}

  /** Admit (and record) or reject one agent turn for a phone. */
  check(phone: string, now = Date.now()): RateDecision {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    if (dayKey !== this.dayKey) {
      this.dayKey = dayKey;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.options.globalPerDay) return "global_limited";

    const cutoff = now - HOUR_MS;
    const recent = (this.perPhone.get(phone) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.options.perPhonePerHour) {
      this.perPhone.set(phone, recent);
      return "phone_limited";
    }
    recent.push(now);
    this.perPhone.set(phone, recent);
    this.dayCount += 1;
    return "ok";
  }

  /**
   * Whether to send the "slow down" notice to a limited phone: at most once
   * per hour per phone, so the notice itself cannot be provoked into spam.
   */
  shouldNotify(phone: string, now = Date.now()): boolean {
    const last = this.noticeSentAt.get(phone);
    if (last !== undefined && now - last < HOUR_MS) return false;
    this.noticeSentAt.set(phone, now);
    return true;
  }
}
