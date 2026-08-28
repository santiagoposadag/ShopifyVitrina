import { describe, expect, it } from "vitest";
import {
  buildEchoReply,
  ECHO_MAX_QUOTED,
  ECHO_OPENERS,
  ECHO_PREFIX,
} from "../src/agent/echo.js";

/**
 * ECHO_MODE stands in for an agent turn so the transport can be proven on its
 * own. Its value is entirely in what it shows the person testing, so that is
 * what these pin.
 */
describe("buildEchoReply", () => {
  it("quotes back what arrived, which is the whole diagnostic", () => {
    // Not decoration: this is the only way to see that a burst was coalesced
    // into ONE turn, that a photo was counted, or that a voice note reached
    // transcription. The outbound leg alone shows none of that.
    const reply = buildEchoReply("(El usuario envió 3 fotos)\nvestido rojo", () => 0);

    expect(reply).toContain("(El usuario envió 3 fotos)");
    expect(reply).toContain("vestido rojo");
  });

  it("marks every reply as a test in the first characters read", () => {
    // If this mode is ever left on by accident, a real customer has to be able
    // to tell at a glance that they are not talking to the store.
    for (let i = 0; i < ECHO_OPENERS.length; i++) {
      expect(buildEchoReply("hola", () => i).startsWith(ECHO_PREFIX)).toBe(true);
    }
  });

  it("varies the opener", () => {
    const first = buildEchoReply("hola", () => 0);
    const second = buildEchoReply("hola", () => 1);
    expect(first).not.toBe(second);
    expect(first).toContain(ECHO_OPENERS[0]);
    expect(second).toContain(ECHO_OPENERS[1]);
  });

  it("truncates a long burst instead of relaying three screens of it", () => {
    // A 37-photo listing joins into a long prompt. The point is to confirm it
    // arrived whole, not to send it back.
    const long = "x".repeat(ECHO_MAX_QUOTED + 500);
    const reply = buildEchoReply(long, () => 0);

    expect(reply).toContain("…");
    expect(reply.length).toBeLessThan(ECHO_MAX_QUOTED + 200);
  });

  it("does not truncate a burst that fits", () => {
    const exact = "y".repeat(ECHO_MAX_QUOTED);
    expect(buildEchoReply(exact, () => 0)).toContain(exact);
  });

  it("says so rather than quoting nothing when the text is empty", () => {
    expect(buildEchoReply("   ", () => 0)).toContain("(sin texto)");
  });

  it("survives a picker that returns an out-of-range index", () => {
    // Math.random() * n cannot exceed n - 1, but the parameter is injectable and
    // an undefined opener would reach the person as "undefined".
    expect(buildEchoReply("hola", () => 99)).toContain(ECHO_OPENERS[ECHO_OPENERS.length - 1]);
    expect(buildEchoReply("hola", () => -3)).toContain(ECHO_OPENERS[0]);
  });

  it("never produces the string 'undefined'", () => {
    for (let i = -2; i < ECHO_OPENERS.length + 2; i++) {
      expect(buildEchoReply("hola", () => i)).not.toContain("undefined");
    }
  });
});
