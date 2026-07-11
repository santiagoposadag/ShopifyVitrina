import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("RateLimiter", () => {
  it("admits up to the per-phone limit, then limits that phone only", () => {
    const limiter = new RateLimiter({ perPhonePerHour: 3, globalPerDay: 100 });
    expect(limiter.check("A", T0)).toBe("ok");
    expect(limiter.check("A", T0 + MINUTE)).toBe("ok");
    expect(limiter.check("A", T0 + 2 * MINUTE)).toBe("ok");
    expect(limiter.check("A", T0 + 3 * MINUTE)).toBe("phone_limited");
    expect(limiter.check("B", T0 + 3 * MINUTE)).toBe("ok"); // other phones unaffected
  });

  it("slides the hour window: old turns stop counting", () => {
    const limiter = new RateLimiter({ perPhonePerHour: 2, globalPerDay: 100 });
    expect(limiter.check("A", T0)).toBe("ok");
    expect(limiter.check("A", T0 + MINUTE)).toBe("ok");
    expect(limiter.check("A", T0 + 2 * MINUTE)).toBe("phone_limited");
    // 61 minutes after the first turn, it has left the window.
    expect(limiter.check("A", T0 + HOUR + MINUTE)).toBe("ok");
  });

  it("enforces the global daily cap across phones and resets on a new day", () => {
    const limiter = new RateLimiter({ perPhonePerHour: 100, globalPerDay: 2 });
    expect(limiter.check("A", T0)).toBe("ok");
    expect(limiter.check("B", T0)).toBe("ok");
    expect(limiter.check("C", T0)).toBe("global_limited");
    // Next UTC day: the circuit breaker resets.
    expect(limiter.check("C", T0 + 24 * HOUR)).toBe("ok");
  });

  it("sends the slow-down notice at most once per hour per phone", () => {
    const limiter = new RateLimiter({ perPhonePerHour: 1, globalPerDay: 100 });
    expect(limiter.shouldNotify("A", T0)).toBe(true);
    expect(limiter.shouldNotify("A", T0 + 30 * MINUTE)).toBe(false);
    expect(limiter.shouldNotify("B", T0 + 30 * MINUTE)).toBe(true); // per phone
    expect(limiter.shouldNotify("A", T0 + HOUR + MINUTE)).toBe(true);
  });
});
