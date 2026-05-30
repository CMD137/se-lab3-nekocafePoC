import { setTimeout as sleep } from "node:timers/promises";

const gateway = process.env.NEKOCAFE_GATEWAY_URL || "http://localhost:8080";
const token = process.env.NEKOCAFE_BEARER_TOKEN || process.argv[2];
const iterations = Number.parseInt(process.env.LOADGEN_ITERATIONS || "120", 10);
const concurrency = Number.parseInt(process.env.LOADGEN_CONCURRENCY || "6", 10);

if (!token) {
  console.error("Usage: node scripts/loadgen.mjs <bearerToken>");
  process.exit(1);
}

async function request(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  await response.text();
}

async function worker(id) {
  for (let index = 0; index < iterations; index += 1) {
    const date = "2026-05-10";
    await Promise.all([
      request(`${gateway}/reservation/v1/availability?storeId=STORE-BJ-001&date=${date}&partySize=4`),
      request(`${gateway}/member/v1/members/MEM-220501208`),
    ]);
    if (id === 0 && index % 10 === 0) {
      console.log(`[loadgen] completed ${index}/${iterations}`);
    }
    await sleep(250);
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
console.log("[loadgen] done");
