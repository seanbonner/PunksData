#!/usr/bin/env node
// For every unique current holder of a V1 or V2 punk, fetch the timestamp
// of that wallet's most-recent OUTBOUND transaction via Etherscan txlist.
// Outbound = wallet was the from-side of an external EOA transaction.
// We page through the last 100 normal transactions per wallet (descending)
// and take the newest one whose from == address. If none found, we record
// lastOutboundTs = null (the wallet has only ever received, or is brand
// new with no outbound).
//
// Output: data/wallets-activity.jsonl, one record per wallet:
//   { "address", "lastOutboundTs", "lastOutboundHash", "fetchedAt" }
//
// State: data/wallets-activity-state.json tracks already-fetched addresses
// so re-runs can resume after interruption. To force a refresh of all
// wallets pass --refresh.

import { existsSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "wallets-activity-state.json");
const OUT_FILE = join(DATA_DIR, "wallets-activity.jsonl");

const KEY = process.env.ETHERSCAN_API_KEY;
if (!KEY) { console.error("ETHERSCAN_API_KEY env var required"); process.exit(1); }

const REFRESH = process.argv.includes("--refresh");

const ETHERSCAN = "https://api.etherscan.io/v2/api";
const POLITE_DELAY_MS = 250;
const FETCH_BATCH_SIZE = 100;

const ZERO = "0x0000000000000000000000000000000000000000";

// Standard burn / vanity / contract addresses we never need to query.
const STATIC_SKIP = new Set([
  ZERO,
  "0x0000000000000000000000000000000000000001",
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
  "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb", // V2 main
  "0xb7f7f6c52f2e2fdb1963eab30438024864c313f6", // V2 wrapper
  "0x6ba6f2207e343923ba692e5cae646fb0f566db8d", // V1 main
  "0x282bdd42f4eb70e7a9d9f40c8fea0825b7f68c5d", // V1 wrapper
]);

function loadBurnWalletsFromBurnedPunks() {
  const burnDir = join(__dirname, "..", "..", "BurnedPunks", "punks");
  if (!existsSync(burnDir)) return new Set();
  const out = new Set();
  for (const fn of readdirSync(burnDir)) {
    if (!fn.endsWith(".md")) continue;
    const md = readFileSync(join(burnDir, fn), "utf8");
    const m = md.match(/final_wallet:\s*"(0x[0-9a-fA-F]{40})"/);
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchLatestOutbound(address) {
  const params = new URLSearchParams({
    chainid: "1",
    module: "account",
    action: "txlist",
    address,
    page: "1",
    offset: String(FETCH_BATCH_SIZE),
    sort: "desc",
    apikey: KEY,
  });
  const url = `${ETHERSCAN}?${params}`;

  let attempt = 0;
  while (true) {
    let j;
    try {
      j = await fetch(url).then((r) => r.json());
    } catch (err) {
      attempt++;
      const wait = Math.min(30000, 500 * 2 ** attempt);
      console.warn(`  ${address}: network error: ${err.message}; backoff ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (j.status === "0" && /no transactions found/i.test(j.message)) {
      return { lastOutboundTs: null, lastOutboundHash: null };
    }
    if (j.status === "1") {
      const txs = j.result;
      const out = txs.find((t) => t.from?.toLowerCase() === address);
      if (!out) return { lastOutboundTs: null, lastOutboundHash: null };
      return { lastOutboundTs: parseInt(out.timeStamp, 10), lastOutboundHash: out.hash };
    }
    const errText = `${j.result || ""} ${j.message || ""}`;
    if (/rate limit|max rate|too many|timeout|server too busy|unexpected error|try again/i.test(errText)) {
      attempt++;
      const wait = Math.min(60000, 1000 * 2 ** attempt);
      console.warn(`  ${address}: ${errText.trim()}; backoff ${wait}ms`);
      if (attempt > 8) {
        console.warn(`  ${address}: giving up after ${attempt} attempts; recording as null`);
        return { lastOutboundTs: null, lastOutboundHash: null, fetchError: errText.trim() };
      }
      await sleep(wait);
      continue;
    }
    throw new Error(`Etherscan ${address}: ${j.message} - ${j.result}`);
  }
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { fetched: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 0) + "\n"); }

async function main() {
  const holders = JSON.parse(readFileSync(join(DATA_DIR, "unique-holders.json"), "utf8"));
  const burnWallets = loadBurnWalletsFromBurnedPunks();
  console.log(`unique holders: ${holders.length}`);
  console.log(`skip set: ${STATIC_SKIP.size} static + ${burnWallets.size} from BurnedPunks`);

  const skip = new Set([...STATIC_SKIP, ...burnWallets]);
  const queryable = holders.filter((h) => !skip.has(h));
  console.log(`queryable: ${queryable.length}`);

  const state = REFRESH ? { fetched: {} } : loadState();
  const todo = queryable.filter((h) => !state.fetched[h]);
  console.log(`already cached: ${queryable.length - todo.length}; remaining: ${todo.length}`);

  // If refreshing, truncate the output file; otherwise append-only.
  const out = createWriteStream(OUT_FILE, { flags: REFRESH ? "w" : "a" });
  if (REFRESH) {
    // Re-emit cached entries even on refresh? No — refresh re-fetches all.
  }

  const fetchedAt = Math.floor(Date.now() / 1000);
  let done = 0;
  const startedAt = Date.now();

  for (const addr of todo) {
    const { lastOutboundTs, lastOutboundHash } = await fetchLatestOutbound(addr);
    const rec = { address: addr, lastOutboundTs, lastOutboundHash, fetchedAt };
    out.write(JSON.stringify(rec) + "\n");
    state.fetched[addr] = fetchedAt;
    done++;
    if (done % 50 === 0 || done === todo.length) {
      saveState(state);
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / elapsed;
      const remaining = (todo.length - done) / rate;
      console.log(`  ${done}/${todo.length} (${rate.toFixed(1)}/sec, ETA ${Math.round(remaining)}s)`);
    }
    await sleep(POLITE_DELAY_MS);
  }
  await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
  saveState(state);
  console.log(`done. wrote ${done} records → ${OUT_FILE}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
