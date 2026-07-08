import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseListing } from "../src/parse-listing.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../");

function messagesFor(folder: string): string[] {
  const dir = join(REPO_ROOT, folder, "mensajes_de_texto");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

describe("parseListing", () => {
  it("parses the Rionegro house (propiedad_1)", () => {
    const parsed = parseListing(messagesFor("propiedad_1"));
    expect(parsed.code).toBe("916");
    expect(parsed.price).toBe(1_150_000_000);
    expect(parsed.area_m2).toBe(230);
  });

  it("parses the Belén apartment and applies the code correction (008 -> 1912)", () => {
    const parsed = parseListing(messagesFor("propiedad_2"));
    // The seller corrected the code from 008 to 1912 in a later message.
    expect(parsed.code).toBe("1912");
    expect(parsed.price).toBe(670_000_000);
    expect(parsed.area_m2).toBe(78);
  });

  it("ignores admin-fee-magnitude numbers when picking the price", () => {
    const parsed = parseListing(["Administración 270.000", "Precio 670.000.000"]);
    expect(parsed.price).toBe(670_000_000);
  });

  it("takes the last code when several are present", () => {
    const parsed = parseListing(["Código 008", "Ya es código 1912"]);
    expect(parsed.code).toBe("1912");
  });
});
