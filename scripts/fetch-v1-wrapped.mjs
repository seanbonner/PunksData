#!/usr/bin/env node
// Pulls all V1 Wrapped (PunksV1Wrapper) Transfer events from Etherscan,
// writes to ../data/v1wrapped_transfers.jsonl.
//
// V1 Wrapped is a standard ERC-721 wrapper deployed in 2022 that allowed
// long-dormant V1 punks to trade as ERC-721 tokens. Mints (Transfer from
// 0x0) are wraps; burns (Transfer to 0x0) are unwraps; everything else is
// a wrapped-punk transfer (typically a sale on OpenSea/Blur — note that
// like the V2 wrapped data, the SALE PRICE is not captured here, only the
// transfer itself).
//
// Reads ETHERSCAN_API_KEY from env. State lives in v1wrapped-state.json.

import { existsSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, parseAbi, toBytes } from "viem";
import { scrapeEvent, getLatestBlock } from "./lib/etherscan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "v1wrapped-state.json");

const KEY = process.env.ETHERSCAN_API_KEY;
if (!KEY) {
  console.error("ETHERSCAN_API_KEY env var required");
  process.exit(1);
}

const V1W_ADDRESS = "0x282bdd42f4eb70e7a9d9f40c8fea0825b7f68c5d";
const V1W_DEPLOY_BLOCK = 14000000; // ~ Jan 2022

const topic0 = (sig) => keccak256(toBytes(sig));

const TRANSFER_EVENT = {
  name: "Transfer",
  sig: "Transfer(address,address,uint256)",
  abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]),
  outFile: "v1wrapped_transfers.jsonl",
};
TRANSFER_EVENT.topic0 = topic0(TRANSFER_EVENT.sig);

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastBlock: null };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function main() {
  const state = loadState();
  const latest = await getLatestBlock(KEY);
  const fromBlock = (state.lastBlock ?? V1W_DEPLOY_BLOCK - 1) + 1;
  console.log(`latest block: ${latest}; scraping blocks ${fromBlock} → ${latest}`);

  if (fromBlock > latest) {
    console.log("up to date; skipping");
    return;
  }

  const out = createWriteStream(join(DATA_DIR, TRANSFER_EVENT.outFile), { flags: "a" });
  const total = await scrapeEvent({
    apiKey: KEY,
    address: V1W_ADDRESS,
    event: TRANSFER_EVENT,
    fromBlock,
    toBlock: latest,
    sink: (line) => out.write(line),
  });
  await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));

  state.lastBlock = latest;
  saveState(state);
  console.log(`\nwrote ${total} records → data/${TRANSFER_EVENT.outFile} (lastBlock=${latest})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
