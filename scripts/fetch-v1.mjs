#!/usr/bin/env node
// Pulls all V1 CryptoPunks contract events from Etherscan, writes JSONL to ../data/.
//
// V1 has the original Assign (claim) events from June 9–18 2017 that the V2
// archive doesn't have, plus the small window of pre-V2 V1 trading. Most of
// the V1 contract has been dormant since the V2 launch on 2017-06-23,
// re-activating after the V1 wrapper was deployed in 2022.
//
// Reads ETHERSCAN_API_KEY from env. State per event type lives in v1-state.json
// so re-runs are incremental.

import { existsSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, parseAbi, toBytes } from "viem";
import { scrapeEvent } from "./lib/etherscan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "v1-state.json");

const KEY = process.env.ETHERSCAN_API_KEY;
if (!KEY) {
  console.error("ETHERSCAN_API_KEY env var required");
  process.exit(1);
}

const V1_ADDRESS = "0x6ba6f2207e343923ba692e5cae646fb0f566db8d";
const V1_DEPLOY_BLOCK = 3800000; // safe lower bound; first observed activity is ~3,850,227 (2017-06-10)

const topic0 = (sig) => keccak256(toBytes(sig));

const EVENTS = [
  {
    name: "Assign",
    sig: "Assign(address,uint256)",
    abi: parseAbi(["event Assign(address indexed to, uint256 punkIndex)"]),
    outFile: "v1_claims.jsonl",
  },
  {
    name: "PunkTransfer",
    sig: "PunkTransfer(address,address,uint256)",
    abi: parseAbi(["event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex)"]),
    outFile: "v1_transfers.jsonl",
  },
  {
    name: "PunkOffered",
    sig: "PunkOffered(uint256,uint256,address)",
    abi: parseAbi(["event PunkOffered(uint256 indexed punkIndex, uint256 minValue, address indexed toAddress)"]),
    outFile: "v1_offers.jsonl",
  },
  {
    name: "PunkBought",
    sig: "PunkBought(uint256,uint256,address,address)",
    abi: parseAbi(["event PunkBought(uint256 indexed punkIndex, uint256 value, address indexed fromAddress, address indexed toAddress)"]),
    outFile: "v1_sales.jsonl",
  },
  {
    name: "PunkNoLongerForSale",
    sig: "PunkNoLongerForSale(uint256)",
    abi: parseAbi(["event PunkNoLongerForSale(uint256 indexed punkIndex)"]),
    outFile: "v1_offer_withdrawals.jsonl",
  },
];

for (const e of EVENTS) e.topic0 = topic0(e.sig);

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastBlock: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function getLatestBlock() {
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${KEY}`;
  const res = await fetch(url).then((r) => r.json());
  return parseInt(res.result, 16);
}

async function main() {
  const state = loadState();
  const latest = await getLatestBlock();
  console.log(`latest block: ${latest}`);

  for (const event of EVENTS) {
    const fromBlock = (state.lastBlock[event.name] ?? V1_DEPLOY_BLOCK - 1) + 1;
    if (fromBlock > latest) {
      console.log(`\n[${event.name}] up to date (lastBlock ${state.lastBlock[event.name]}); skipping`);
      continue;
    }

    console.log(`\n[${event.name}] scraping blocks ${fromBlock} → ${latest}`);
    const out = createWriteStream(join(DATA_DIR, event.outFile), { flags: "a" });
    let lastBlockSeen = fromBlock - 1;

    const total = await scrapeEvent({
      apiKey: KEY,
      address: V1_ADDRESS,
      event,
      fromBlock,
      toBlock: latest,
      sink: (line) => {
        out.write(line);
        const rec = JSON.parse(line);
        if (rec.blockNumber > lastBlockSeen) lastBlockSeen = rec.blockNumber;
      },
    });
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));

    state.lastBlock[event.name] = latest;
    saveState(state);
    console.log(`  wrote ${total} records → data/${event.outFile} (lastBlock=${latest})`);
  }

  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
