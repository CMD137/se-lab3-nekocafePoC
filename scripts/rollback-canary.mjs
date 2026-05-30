import { spawnSync } from "node:child_process";
import path from "node:path";

const script = path.resolve("scripts/set-canary-weight.mjs");
const result = spawnSync(process.execPath, [script, "100", "0"], {
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("canary rollback completed: all traffic returned to stable");
