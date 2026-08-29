// One real customer turn asking for the cart the user originally asked for.
// Separate process: the running server is untouched.
import { loadConfig, loadDotEnv } from "./src/config.js";
import { openDb } from "./src/data/db.js";
import { ShopifyClient } from "./src/shopify/client.js";
import { CatalogCache } from "./src/shopify/cache.js";
import { runAgentTurn } from "./src/agent/agent.js";
import type { TurnContext } from "./src/types.js";

loadDotEnv();
const config = loadConfig();
const db = openDb(":memory:");
const shopify = new ShopifyClient(config);
const events: string[] = [];
const log = {
  info: (o: any, m?: string) => {
    if (o?.tool) events.push(`  tool: ${o.tool}  ${String(o.input).slice(0, 120)}`);
    if (o?.tools !== undefined) events.push(`  TURN tools=[${o.tools}] numTurns=${o.numTurns} end=${o.resultSubtype}`);
  },
  warn: () => undefined,
  error: (o: any, m?: string) => events.push(`  ERROR ${m}`),
} as never;
const sent: string[] = [];

await runAgentTurn(
  {
    db,
    channel: { sendText: async (_p: string, t: string) => { sent.push(t); }, downloadMedia: () => { throw new Error("no"); } },
    config,
    shopify,
    cache: new CatalogCache(shopify, 0),
    log,
  } as never,
  { phone: "573153041979", role: "customer", turnKey: "probe:cart" } as TurnContext,
  "¿Me podrías armar un carrito para ir al checkout? Una vela de citronela, una de manzanilla y una de canela, del menor precio posible.",
);

console.log(events.join("\n"));
console.log("\n--- reply ---");
console.log(sent[0] ?? "(nothing sent)");
const url = /https:\/\/[^\s]*\/cart\/[^\s]+/.exec(sent[0] ?? "")?.[0];
console.log("\ncart url found:", url ?? "(NONE)");
if (url) {
  const res = await fetch(url, { redirect: "manual" });
  console.log("HTTP", res.status, "→", (res.headers.get("location") ?? "").slice(0, 90));
}
