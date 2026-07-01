// Shared Etherscan v2 getLogs helper with pagination + range bisection.
//
// Usage: import { scrapeEvent } from "./lib/etherscan.mjs"
// Each event is scraped across a block range. The function chunks by block
// range and paginates within each chunk; if a chunk hits the 10K-records
// API cap it bisects automatically.

import { decodeEventLog } from "viem";

const ETHERSCAN = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 1;
const PAGE_SIZE = 1000;
const MAX_PAGES_PER_CHUNK = 10; // API caps total to 10K records per (range, query)
const POLITE_DELAY_MS = 250;
const DEFAULT_CHUNK = 500_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

async function getLogs({ apiKey, address, topic0, fromBlock, toBlock, page }) {
  const params = new URLSearchParams({
    chainid: String(CHAIN_ID),
    module: "logs",
    action: "getLogs",
    address,
    topic0,
    fromBlock: String(fromBlock),
    toBlock: String(toBlock),
    page: String(page),
    offset: String(PAGE_SIZE),
    apikey: apiKey,
  });
  const url = `${ETHERSCAN}?${params}`;

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
    const j = await res.json().catch(() => null);
    if (!j) {
      attempt++;
      const wait = Math.min(30000, 500 * 2 ** attempt);
      console.warn(`  bad response; backoff ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (j.status === "1") return j.result;
    if (j.status === "0" && /no records found/i.test(j.message)) return [];
    if (/rate limit|max rate|too many|timeout|server too busy/i.test(j.result || j.message || "")) {
      attempt++;
      const wait = Math.min(60000, 1000 * 2 ** attempt);
      console.warn(`  rate-limited; backoff ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Etherscan: ${j.message} - ${j.result}`);
  }
}

/**
 * Scrape one event across a block range, writing decoded records to `sink`.
 * @param {object} opts
 * @param {string} opts.apiKey - Etherscan API key
 * @param {string} opts.address - contract address
 * @param {object} opts.event - { topic0, abi, name }
 * @param {number} opts.fromBlock - inclusive
 * @param {number} opts.toBlock - inclusive
 * @param {(record: object) => void} opts.sink - called with each decoded record
 * @param {number} [opts.chunkSize] - initial chunk size in blocks
 * @returns {Promise<number>} total records written
 */
export async function scrapeEvent({ apiKey, address, event, fromBlock, toBlock, sink, chunkSize = DEFAULT_CHUNK }) {
  const stack = [];
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    stack.push([from, Math.min(from + chunkSize - 1, toBlock)]);
  }

  let total = 0;
  while (stack.length) {
    const [from, to] = stack.shift();
    const collected = [];
    let page = 1;
    let truncated = false;

    while (page <= MAX_PAGES_PER_CHUNK) {
      const logs = await getLogs({ apiKey, address, topic0: event.topic0, fromBlock: from, toBlock: to, page });
      collected.push(...logs);
      if (logs.length < PAGE_SIZE) break;
      page++;
      if (page > MAX_PAGES_PER_CHUNK) {
        truncated = true;
        break;
      }
      await sleep(POLITE_DELAY_MS);
    }

    if (truncated && from < to) {
      const mid = Math.floor((from + to) / 2);
      stack.unshift([from, mid], [mid + 1, to]);
      console.log(`  [${event.name}] block ${from}-${to}: hit 10K cap, bisecting at ${mid}`);
      await sleep(POLITE_DELAY_MS);
      continue;
    }

    for (const log of collected) {
      const decoded = decodeEventLog({ abi: event.abi, data: log.data, topics: log.topics });
      const record = {
        blockNumber: parseInt(log.blockNumber, 16),
        timestamp: parseInt(log.timeStamp, 16),
        transactionHash: log.transactionHash,
        logIndex: parseInt(log.logIndex, 16),
        ...Object.fromEntries(Object.entries(decoded.args).filter(([k]) => Number.isNaN(Number(k)))),
      };
      sink(JSON.stringify(record, jsonReplacer) + "\n");
      total++;
    }

    console.log(`  [${event.name}] block ${from}-${to}: +${collected.length} (running total ${total})`);
    if (stack.length) await sleep(POLITE_DELAY_MS);
  }

  return total;
}

export async function getLatestBlock(apiKey) {
  const url = `${ETHERSCAN}?chainid=${CHAIN_ID}&module=proxy&action=eth_blockNumber&apikey=${apiKey}`;
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url).then((r) => r.json());
    } catch (err) {
      attempt++;
      await sleep(Math.min(30000, 500 * 2 ** attempt));
      continue;
    }
    const block = parseInt(res.result, 16);
    if (!Number.isNaN(block)) return block;
    attempt++;
    const wait = Math.min(30000, 500 * 2 ** attempt);
    console.warn(`  eth_blockNumber failed (${res.message ?? res.result}); backoff ${wait}ms`);
    await sleep(wait);
  }
}

export { DEFAULT_CHUNK };
