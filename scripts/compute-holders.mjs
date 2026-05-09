#!/usr/bin/env node
// Derive current holder + last-move timestamp for every punk on V1 and V2,
// chasing through wrapper contracts so the recorded holder is always the
// end-user wallet (not a wrapper contract). Writes data/holders.json.
//
// V2 chain: V2 main transfers → if owner is WPUNKS contract, follow into
//           wrappedPunkTransfers for the actual end-user.
// V1 chain: V1 claims + transfers → if owner is V1 Wrapper contract, follow
//           into v1wrapped_transfers for the end-user.
//
// "lastMoveTs" is the timestamp of the most recent ownership-changing event
// across whichever leg of the chain is currently load-bearing.

import { createReadStream, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

const V2_MAIN = "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";
const V2_WRAPPER = "0xb7f7f6c52f2e2fdb1963eab30438024864c313f6";
const V1_MAIN = "0x6ba6f2207e343923ba692e5cae646fb0f566db8d";
const V1_WRAPPER = "0x282bdd42f4eb70e7a9d9f40c8fea0825b7f68c5d";
const ZERO = "0x0000000000000000000000000000000000000000";

async function* readJsonl(file) {
  const rl = createInterface({ input: createReadStream(join(DATA_DIR, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) yield JSON.parse(line);
  }
}

// Pick the latest event per punk id, given an iterator of records and a
// function that extracts (id, ts, holder) from each record. Holder is the
// "to" side of an ownership change.
async function latestPerPunk(file, extractor) {
  const out = {};
  for await (const rec of readJsonl(file)) {
    const { id, ts, holder } = extractor(rec);
    if (id == null || ts == null) continue;
    const cur = out[id];
    if (!cur || ts > cur.ts) out[id] = { ts, holder: holder?.toLowerCase() ?? null };
  }
  return out;
}

async function main() {
  function take(map, id, ts, holder) {
    const cur = map[id];
    if (!cur || ts > cur.ts) map[id] = { ts, holder: holder.toLowerCase() };
  }

  console.log("walking V2 assigns + transfers...");
  const v2Main = {};
  // V2 Assigns: the airdrop on 2017-06-23 (covers all 10K, including punks
  // that never moved afterwards and so don't appear in transfers).
  for await (const r of readJsonl("v2_assigns.jsonl")) {
    take(v2Main, Number(r.punkIndex), r.timestamp, r.to);
  }
  // V2 PunkTransfers — V2 fixed the V1 bug, so transfers cover both moves
  // and post-sale ownership changes.
  for await (const r of readJsonl("transfers.jsonl")) {
    take(v2Main, Number(r.punkId), r.timestamp, r.to);
  }

  console.log("walking V2 wrapped transfers...");
  const v2Wrapped = await latestPerPunk("wrappedPunkTransfers.jsonl", (r) => ({ id: Number(r.punkId), ts: r.timestamp, holder: r.to }));

  console.log("walking V1 claims + transfers + sales...");
  const v1Main = {};
  for await (const r of readJsonl("v1_claims.jsonl")) {
    take(v1Main, Number(r.punkIndex), r.timestamp, r.to);
  }
  for await (const r of readJsonl("v1_transfers.jsonl")) {
    take(v1Main, Number(r.punkIndex), r.timestamp, r.to);
  }
  // V1 sales matter for ownership because V1's buyPunk does NOT emit a
  // corresponding PunkTransfer (one of the original V1 bugs). Wrapping
  // happens via offer→buy, so the wrapper-as-owner state lives only in
  // PunkBought events.
  for await (const r of readJsonl("v1_sales.jsonl")) {
    take(v1Main, Number(r.punkIndex), r.timestamp, r.toAddress);
  }

  console.log("walking V1 wrapped transfers...");
  const v1Wrapped = await latestPerPunk("v1wrapped_transfers.jsonl", (r) => ({ id: Number(r.tokenId), ts: r.timestamp, holder: r.to }));

  // Resolve end-user holders by chasing wrapper contracts.
  function resolve(mainMap, wrappedMap, wrapperAddr) {
    const out = {};
    const ids = new Set([...Object.keys(mainMap), ...Object.keys(wrappedMap)]);
    for (const idStr of ids) {
      const id = Number(idStr);
      const main = mainMap[id];
      const wrapped = wrappedMap[id];
      if (!main && !wrapped) continue;
      // If main holder is the wrapper contract, the end-user is the wrapped holder.
      if (main && main.holder === wrapperAddr && wrapped && wrapped.holder !== ZERO) {
        out[id] = {
          holder: wrapped.holder,
          lastMoveTs: Math.max(main.ts, wrapped.ts),
          wrapped: true,
        };
      } else if (main) {
        out[id] = {
          holder: main.holder,
          lastMoveTs: main.ts,
          wrapped: false,
        };
      } else if (wrapped && wrapped.holder !== ZERO) {
        // Edge case: wrapped without main record. Shouldn't happen normally.
        out[id] = { holder: wrapped.holder, lastMoveTs: wrapped.ts, wrapped: true };
      }
    }
    return out;
  }

  const v2 = resolve(v2Main, v2Wrapped, V2_WRAPPER);
  const v1 = resolve(v1Main, v1Wrapped, V1_WRAPPER);

  console.log(`v2: ${Object.keys(v2).length} punks resolved`);
  console.log(`v1: ${Object.keys(v1).length} punks resolved`);

  // Tally for sanity check
  const v1Wrap = Object.values(v1).filter((x) => x.wrapped).length;
  const v2Wrap = Object.values(v2).filter((x) => x.wrapped).length;
  console.log(`  v1 currently wrapped: ${v1Wrap}; unwrapped: ${Object.keys(v1).length - v1Wrap}`);
  console.log(`  v2 currently wrapped: ${v2Wrap}; unwrapped: ${Object.keys(v2).length - v2Wrap}`);

  // Unique holders across both contracts
  const holders = new Set();
  for (const m of [v1, v2]) for (const x of Object.values(m)) holders.add(x.holder);
  console.log(`unique end-user holders across V1+V2: ${holders.size}`);

  writeFileSync(join(DATA_DIR, "holders.json"), JSON.stringify({ v1, v2 }, null, 0) + "\n");
  writeFileSync(join(DATA_DIR, "unique-holders.json"), JSON.stringify([...holders].sort(), null, 2) + "\n");
  console.log("wrote data/holders.json and data/unique-holders.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
