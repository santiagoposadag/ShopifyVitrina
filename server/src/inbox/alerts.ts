/**
 * Tracks consecutive agent failures so the owner hears about an outage from
 * the assistant itself — in a pilot, the owner's WhatsApp is the monitoring
 * system. An alert fires when the threshold is reached, then at most once per
 * cooldown while the failures continue. Any success resets the streak.
 */
export class ConsecutiveFailureAlert {
  private failures = 0;
  private lastAlertAt: number | undefined;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 60 * 60 * 1000,
  ) {}

  recordSuccess(): void {
    this.failures = 0;
  }

  /** Record one failure; returns true when an alert should be sent now. */
  recordFailure(now = Date.now()): boolean {
    this.failures += 1;
    if (this.failures < this.threshold) return false;
    if (this.lastAlertAt !== undefined && now - this.lastAlertAt < this.cooldownMs) return false;
    this.lastAlertAt = now;
    return true;
  }
}
