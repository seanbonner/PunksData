#!/usr/bin/env node
// Pulls V2 main contract Assign events from Etherscan. These are the
// 10,000 airdrop assignments on 2017-06-23 that the cryptopunks.app API
// doesn't surface. Without them we can't determine the current holder
// for any V2 punk that has never moved since launch.

import { existsSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, parseAbi, toBytes } from "viem";
import { scrapeEvent } from "./lib/etherscan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "v2-assigns-state.json");

const KEY = process.env.ETHERSCAN_API_KEY;
if (!KEY) {
  console.error("ETHERSCAN_API_KEY env var required");
  process.exit(1);
}

const V2_ADDRESS = "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";
const V2_DEPLOY_BLOCK = 3914000; // V2 deployed 2017-06-23

const ASSIGN = {
  name: "Assign",
  sig: "Assign(address,uint256)",
  abi: parseAbi(["event Assign(address indexed to, uint256 punkIndex)"]),
  outFile: "v2_assigns.jsonl",
};
ASSIGN.topic0 = keccak256(toBytes(ASSIGN.sig));

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastBlock: null };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n"); }

async function getLatestBlock() {
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${KEY}`;
  const res = await fetch(url).then((r) => r.json());
  const block = parseInt(res.result, 16);
  if (Number.isNaN(block)) throw new Error(`eth_blockNumber failed: ${res.message ?? res.result}`);
  return block;
}

async function main() {
  const state = loadState();
  const latest = await getLatestBlock();
  const fromBlock = (state.lastBlock ?? V2_DEPLOY_BLOCK - 1) + 1;
  if (fromBlock > latest) { console.log("up to date"); return; }
  console.log(`scraping V2 Assigns blocks ${fromBlock} → ${latest}`);

  const out = createWriteStream(join(DATA_DIR, ASSIGN.outFile), { flags: "a" });
  const total = await scrapeEvent({
    apiKey: KEY,
    address: V2_ADDRESS,
    event: ASSIGN,
    fromBlock,
    toBlock: latest,
    sink: (line) => out.write(line),
  });
  await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));

  state.lastBlock = latest;
  saveState(state);
  console.log(`\nwrote ${total} records → data/${ASSIGN.outFile}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
