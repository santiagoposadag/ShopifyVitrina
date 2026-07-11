import { describe, expect, it } from "vitest";
import { ConsecutiveFailureAlert } from "../src/alerts.js";

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("ConsecutiveFailureAlert", () => {
  it("alerts on the Nth consecutive failure, not before", () => {
    const alert = new ConsecutiveFailureAlert(3, HOUR);
    expect(alert.recordFailure(T0)).toBe(false);
    expect(alert.recordFailure(T0 + MINUTE)).toBe(false);
    expect(alert.recordFailure(T0 + 2 * MINUTE)).toBe(true);
  });

  it("a success resets the streak", () => {
    const alert = new ConsecutiveFailureAlert(3, HOUR);
    alert.recordFailure(T0);
    alert.recordFailure(T0 + MINUTE);
    alert.recordSuccess();
    expect(alert.recordFailure(T0 + 2 * MINUTE)).toBe(false); // streak restarted at 1
  });

  it("respects the cooldown while failures continue, then alerts again", () => {
    const alert = new ConsecutiveFailureAlert(3, HOUR);
    alert.recordFailure(T0);
    alert.recordFailure(T0 + MINUTE);
    expect(alert.recordFailure(T0 + 2 * MINUTE)).toBe(true);
    expect(alert.recordFailure(T0 + 10 * MINUTE)).toBe(false); // within cooldown
    expect(alert.recordFailure(T0 + HOUR + 3 * MINUTE)).toBe(true); // cooldown elapsed
  });
});
