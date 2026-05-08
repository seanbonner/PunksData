#!/usr/bin/env node
// Pulls CryptoPunks transaction history from cryptopunks.app and stores it
// as five chronological JSONL files (one per event type) in ../data/.
//
// First run does a full backfill from now back to 2017. Subsequent runs are
// incremental: walks newest-first from the API and stops as soon as it sees
// a record we already have (tracked in state.json).
//
// The API's pageInfo.hasNextPage flag is unreliable; we paginate until the
// response array is empty or we hit our previous checkpoint.

import { createWriteStream, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "state.json");

const API = "https://www.cryptopunks.app/api/punks";
const PAGE_SIZE = 1000;
const POLITE_DELAY_MS = 250;

// Per-type config. The API uses inconsistent names across request params,
// the `types` filter, response data keys, and pageInfo keys — wrappedPunkTransfers
// in particular is shortened to `wrappedTransfers` everywhere except response data.
const TYPES = [
  { key: "sales",                responseField: "sales",                pageInfoKey: "sales",            cursorParam: "salesCursor",            typeFilter: "sales",            tsField: "timestamp" },
  { key: "bids",                 responseField: "bids",                 pageInfoKey: "bids",             cursorParam: "bidsCursor",             typeFilter: "bids",             tsField: "bidAt"     },
  { key: "offers",               responseField: "offers",               pageInfoKey: "offers",           cursorParam: "offersCursor",           typeFilter: "offers",           tsField: "offeredAt" },
  { key: "transfers",            responseField: "transfers",            pageInfoKey: "transfers",        cursorParam: "transfersCursor",        typeFilter: "transfers",        tsField: "timestamp" },
  { key: "wrappedPunkTransfers", responseField: "wrappedPunkTransfers", pageInfoKey: "wrappedTransfers", cursorParam: "wrappedTransfersCursor", typeFilter: "wrappedTransfers", tsField: "timestamp" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastSeenId: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function fetchPage({ cursor, typeFilter, cursorParam }) {
  const params = new URLSearchParams({
    action: "recent-transactions",
    limit: String(PAGE_SIZE),
    types: typeFilter,
  });
  if (cursor) params.set(cursorParam, cursor);
  const url = `${API}?${params}`;

  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      attempt++;
      const wait = Math.min(30000, 500 * 2 ** attempt);
      console.warn(`  network error: ${err.message}; backoff ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      attempt++;
      const wait = Math.min(60000, 1000 * 2 ** attempt);
      console.warn(`  HTTP ${res.status}; backoff ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

async function fetchType(typeConfig, lastSeenId) {
  const { key, responseField, pageInfoKey, cursorParam, typeFilter, tsField } = typeConfig;
  console.log(`\n[${key}] starting (checkpoint: ${lastSeenId ?? "none — full backfill"})`);

  const out = join(DATA_DIR, `${key}.jsonl`);
  const collected = [];
  let cursor = null;
  let pages = 0;
  let stopped = false;

  while (!stopped) {
    const json = await fetchPage({ cursor, typeFilter, cursorParam });
    const arr = json?.data?.[responseField] ?? [];
    if (arr.length === 0) {
      stopped = true;
      break;
    }
    pages++;

    let stoppedHere = false;
    for (const rec of arr) {
      if (lastSeenId && rec.id === lastSeenId) {
        stoppedHere = true;
        break;
      }
      collected.push(rec);
    }

    const oldest = arr[arr.length - 1];
    const oldestDate = new Date(oldest[tsField] * 1000).toISOString().slice(0, 10);
    console.log(`  page ${pages}: +${arr.length} records (oldest in page: ${oldestDate}); collected so far: ${collected.length}`);

    if (stoppedHere) {
      console.log(`  hit previous checkpoint id=${lastSeenId}; stopping.`);
      break;
    }

    cursor = json?.pageInfo?.[pageInfoKey]?.endCursor ?? null;
    if (!cursor) {
      stopped = true;
      break;
    }
    await sleep(POLITE_DELAY_MS);
  }

  if (collected.length === 0) {
    console.log(`  nothing new.`);
    return { newestId: lastSeenId ?? null, count: 0 };
  }

  // Append in chronological order (oldest-first). collected is newest-first.
  const stream = createWriteStream(out, { flags: "a" });
  for (let i = collected.length - 1; i >= 0; i--) {
    stream.write(JSON.stringify(collected[i]) + "\n");
  }
  await new Promise((res, rej) => stream.end((err) => (err ? rej(err) : res())));

  const newestId = collected[0].id;
  console.log(`  wrote ${collected.length} records to ${out}`);
  return { newestId, count: collected.length };
}

async function main() {
  const state = loadState();
  const summary = {};

  for (const t of TYPES) {
    const lastSeenId = state.lastSeenId[t.key] ?? null;
    const result = await fetchType(t, lastSeenId);
    summary[t.key] = result.count;
    if (result.newestId) state.lastSeenId[t.key] = result.newestId;
    saveState(state); // persist after each type so a crash doesn't lose progress
  }

  console.log("\n=== summary ===");
  for (const [k, v] of Object.entries(summary)) {
    console.log(`  ${k}: +${v}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
