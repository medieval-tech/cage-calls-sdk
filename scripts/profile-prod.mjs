// Profiles every SDK read against mainnet: requests, bytes and time per method, per backend operation.
// Usage: pnpm profile:prod [methodPrefix] [--runs N] [--json out.json]
// MAINNET_RPC_URL picks the primary RPC (the app uses Alchemy); Cartridge is the fallback.
import { writeFileSync } from "node:fs";
import {
  createCageCallsClient, createFallbackRpcTransport, createIpfsMetadataTransport, createToriiGraphqlTransport,
} from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const runs = Number(flag("--runs", 1));
const jsonOut = flag("--json");
const only = args[0];

// Real mainnet inputs, picked 2026-10-15: the heaviest bettor (149 buys, 75 relics), a typical one (20 buys),
// the busiest fight (1123 buys), the latest fight, and the largest event.
const HEAVY = "0x07ea2992ad3402e855de507f737fdc6ff333473b1fad0a9229e5bb30bf54e247";
const TYPICAL = "0x0019e6db3f71c317003d88ba07e17d6c490b6ac319b7bb09b28c9eb9c5a720da";
const BUSY_FIGHT = 0x90n;
const LATEST_FIGHT = 0xa2n;
const LATEST_MARKET = 0xf751d372b7a89ec1ef774644a269e8c32c8696bebbb66d083b345f9695a86e0dn;
const POSITION = 0x584321ccde79ca3e6118feca4223202e1449c8b60baa628deb9f229462d5f71dn;
const EVENT = { seasonId: 0x7ean, eventName: "84f952a8-77ab-4fef-bc7d-85590286ea38" };
const RELIC = 4n;

const log = [];
function labelOf(url, init) {
  const u = String(url);
  if (u.includes("/sql?")) return "sql:" + decodeURIComponent(u.split("query=")[1] ?? "").replace(/\s+/g, " ").match(/FROM\s+("?[\w-]+"?)/i)?.[1];
  if (!init.body) return "GET " + new URL(u).pathname.split("/").slice(0, 3).join("/");
  try {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) return `rpc-batch[${body.length}]`;
    if (body.method) return body.method === "starknet_call" ? "starknet_call" : body.method;
    return body.query?.match(/\)\{(\w+)\(/)?.[1] ?? body.query?.match(/\{\s*(\w+)/)?.[1] ?? "graphql";
  } catch { return "?"; }
}
const tracedFetch = async (url, init = {}) => {
  const entry = { host: new URL(url).host.split(".")[0], label: labelOf(url, init), ms: 0, bytes: 0, status: 0 };
  const started = performance.now();
  try {
    const res = await fetch(url, init);
    entry.status = res.status;
    entry.bytes = (await res.clone().arrayBuffer()).byteLength;
    return res;
  } catch (error) {
    entry.status = error.name;
    throw error;
  } finally {
    entry.ms = performance.now() - started;
    log.push(entry);
  }
};

const cartridge = "https://api.cartridge.gg/x/starknet/mainnet";
const client = createCageCallsClient({
  network: "mainnet",
  // Same budget and transports as client/src/contexts/cageCallsSdk.tsx.
  budget: { pageSize: 200, maxConcurrency: 4, maxToriiItems: 100_000, maxToriiPages: 1_000, maxRpcItems: 100_000, maxRpcPages: 500 },
  transports: {
    rpc: createFallbackRpcTransport({ primaryUrl: process.env.MAINNET_RPC_URL || cartridge, fallbackUrl: cartridge, fetch: tracedFetch, maxConcurrency: 4, maxRetries: 1 }),
    torii: createToriiGraphqlTransport({ url: "https://torii-mainnet.medievaltech.xyz", fetch: tracedFetch }),
    metadata: createIpfsMetadataTransport({ gateways: ["https://moccasin-occasional-salmon-888.mypinata.cloud/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"], fetch: tracedFetch }),
  },
});
const c = client;

const methods = {
  "fights.get": () => c.fights.get(LATEST_FIGHT),
  "fights.getMany(20)": () => c.fights.getMany(Array.from({ length: 20 }, (_, i) => LATEST_FIGHT - BigInt(i))),
  "fights.all": () => c.fights.all(),
  "fights.page": () => c.fights.page({ limit: 20 }),
  "fights.feed(20)": () => c.fights.feed({ limit: 20 }),
  "fights.feed(20,viewer)": () => c.fights.feed({ limit: 20, viewer: HEAVY }),
  "fights.feedMany(busy)": () => c.fights.feedMany([BUSY_FIGHT]),
  "fights.feedAll": () => c.fights.feedAll(),
  "fights.accountFeed(heavy)": () => c.fights.accountFeed(HEAVY, { limit: 20 }),
  "fights.accountFeedAll(heavy)": () => c.fights.accountFeedAll(HEAVY),
  "fights.accountFeedAll(typical)": () => c.fights.accountFeedAll(TYPICAL),
  "fights.buys(busy)": () => c.fights.buys(BUSY_FIGHT, { limit: 50 }),
  "fights.buysAll(busy)": () => c.fights.buysAll(BUSY_FIGHT),
  "fights.viewerState": () => c.fights.viewerState(BUSY_FIGHT, HEAVY),
  "fights.potState(busy)": () => c.fights.potState(BUSY_FIGHT),
  "fights.winner": () => c.fights.winner(BUSY_FIGHT, HEAVY),
  "fights.portfolio(heavy)": () => c.fights.portfolio(HEAVY, { limit: 20 }),
  "fights.portfolioAll(heavy)": () => c.fights.portfolioAll(HEAVY),
  "fightEvents.get": () => c.fightEvents.get(EVENT.eventName, { seasonId: EVENT.seasonId }),
  "fightEvents.page": () => c.fightEvents.page({ limit: 10 }),
  "fightEvents.all": () => c.fightEvents.all(),
  "events.get": () => c.events.get(EVENT),
  "accounts.event(heavy)": () => c.accounts.event(EVENT, HEAVY),
  "accounts.fightStates(heavy)": () => c.accounts.fightStates(HEAVY, { limit: 20 }),
  "accounts.portfolio(heavy)": () => c.accounts.portfolio(HEAVY),
  "accounts.portfolio(typical)": () => c.accounts.portfolio(TYPICAL),
  "markets.get": () => c.markets.get(LATEST_MARKET),
  "markets.all": () => c.markets.all(),
  "markets.page": () => c.markets.page({ limit: 20 }),
  "markets.catalog": () => c.markets.catalog({ limit: 20 }),
  "markets.state": () => c.markets.state(LATEST_MARKET, 3),
  "markets.position": () => c.markets.position(POSITION),
  "markets.conditionalBalance": () => c.markets.conditionalBalance(HEAVY, POSITION),
  "fighters.get": () => c.fighters.get(1n),
  "fighters.all": () => c.fighters.all(),
  "fighters.page": () => c.fighters.page({ limit: 20 }),
  "tokens.accountBalances(heavy)": () => c.tokens.accountBalances(HEAVY),
  "tokens.strikeTicketBalances(heavy)": () => c.tokens.strikeTicketBalances(HEAVY),
  "tokens.callsBalance": () => c.tokens.callsBalance(HEAVY),
  "gacha.pool": () => c.gacha.pool(LATEST_FIGHT),
  "gacha.poolStates(20)": () => c.gacha.poolStates(Array.from({ length: 20 }, (_, i) => LATEST_FIGHT - BigInt(i))),
  "gacha.userStates(20,heavy)": () => c.gacha.userStates(Array.from({ length: 20 }, (_, i) => LATEST_FIGHT - BigInt(i)), HEAVY),
  "gacha.availableTokenIds": () => c.gacha.availableTokenIds(LATEST_FIGHT, { limit: 50 }),
  "gacha.availableTokenIdsAll": () => c.gacha.availableTokenIdsAll(LATEST_FIGHT),
  "relics.get": () => c.relics.get(RELIC),
  "relics.page": () => c.relics.page({ limit: 24 }),
  "relics.collection": () => c.relics.collection(),
  "relics.inventory": () => c.relics.inventory(),
  "relics.stats": () => c.relics.stats(),
  "relics.owned(heavy)": () => c.relics.owned(HEAVY),
  "relics.ownedInventory(heavy)": () => c.relics.ownedInventory(HEAVY),
  "activity.page": () => c.activity.page({ limit: 50 }),
  "analytics.summary": () => c.analytics.summary(),
  "analytics.snapshot": () => c.analytics.snapshot(),
  "admin.capabilities": () => c.admin.capabilities(HEAVY),
  "admin.roles": () => c.admin.roles(),
  "admin.registeredTokensAll": () => c.admin.registeredTokensAll(),
};

function sizeOf(data) {
  if (Array.isArray(data)) return `${data.length} items`;
  if (Array.isArray(data?.items)) return `${data.items.length} items`;
  return "ok";
}

const results = [];
for (const [name, call] of Object.entries(methods)) {
  if (only && !name.startsWith(only)) continue;
  for (let run = 0; run < runs; run++) {
    const before = log.length;
    const started = performance.now();
    let outcome;
    try {
      const result = await call();
      outcome = sizeOf(result?.data) + (result?.meta?.complete === false ? ", incomplete" : "") + (result?.meta?.source ? `, ${result.meta.source}` : "");
    } catch (error) {
      outcome = `THREW ${error.name}: ${String(error.message).slice(0, 100)}`;
    }
    const requests = log.slice(before);
    const ops = {};
    for (const r of requests) {
      const key = `${r.host} ${r.label}${r.status === 200 ? "" : ` [${r.status}]`}`;
      const op = (ops[key] ??= { n: 0, bytes: 0, maxMs: 0 });
      op.n++; op.bytes += r.bytes; op.maxMs = Math.max(op.maxMs, r.ms);
    }
    results.push({ name, run, ms: performance.now() - started, requests: requests.length, bytes: requests.reduce((a, r) => a + r.bytes, 0), outcome, ops });
  }
}

const kb = (b) => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1048576).toFixed(1)}MB`;
const byName = Map.groupBy(results, (r) => r.name);
const rows = [...byName].map(([name, rs]) => {
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  return { name, p50: ms[ms.length >> 1], min: ms[0], max: ms.at(-1), last: rs.at(-1) };
}).sort((a, b) => b.p50 - a.p50);
console.log(`method${" ".repeat(30)}p50(ms)  [min-max] over ${runs} run(s)   reqs  bytes   result`);
for (const r of rows) {
  console.log(`${r.name.padEnd(36)} ${String(Math.round(r.p50)).padStart(7)}  [${Math.round(r.min)}-${Math.round(r.max)}]`.padEnd(64) + `${String(r.last.requests).padStart(5)}  ${kb(r.last.bytes).padStart(6)}   ${r.last.outcome}`);
  for (const [op, v] of Object.entries(r.last.ops).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`      ${String(v.n).padStart(4)}x ${op.padEnd(48)} ${kb(v.bytes).padStart(7)}  max ${Math.round(v.maxMs)}ms`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
