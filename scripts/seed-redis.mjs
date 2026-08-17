// One-time (or re-run-safe) seed: pushes the sample catalog + starting
// live-show state into Redis. Safe to re-run — it just overwrites the
// `products` and `state` keys with these seed values.
//
// Usage (env vars must be present — see README "Deploying" section):
//   node --env-file=.env.development.local scripts/seed-redis.mjs

import { readFile } from "fs/promises";
import path from "path";
import { Redis } from "@upstash/redis";

const KEYS = {
  products: "loot-depot:products",
  state: "loot-depot:state",
  version: "loot-depot:version",
};

async function main() {
  const redis = Redis.fromEnv();

  const dataDir = path.join(process.cwd(), "data");
  const products = JSON.parse(await readFile(path.join(dataDir, "products.json"), "utf-8"));
  const state = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf-8"));

  await redis.set(KEYS.products, products);
  await redis.set(KEYS.state, state);
  await redis.incr(KEYS.version);

  console.log(`Seeded ${products.length} products and initial state into Redis.`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
