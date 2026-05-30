const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";
const P95_THRESHOLD_MS = Number.parseFloat(process.env.CANARY_P95_THRESHOLD_MS || "800");
const ERROR_RATE_THRESHOLD = Number.parseFloat(process.env.CANARY_ERROR_RATE_THRESHOLD || "0.01");
const WINDOW = process.env.CANARY_WINDOW || "2m";
const POLL_INTERVAL_MS = Number.parseInt(process.env.CANARY_POLL_INTERVAL_MS || "15000", 10);

async function query(expression) {
  const url = new URL("/api/v1/query", PROMETHEUS_URL);
  url.searchParams.set("query", expression);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Prometheus query failed with status ${response.status}`);
  }
  const payload = await response.json();
  const value = payload?.data?.result?.[0]?.value?.[1];
  return value ? Number.parseFloat(value) : NaN;
}

async function rollback() {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["scripts/rollback-canary.mjs"], {
    stdio: "inherit",
    shell: false,
  });
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`rollback exited with code ${code}`));
    });
  });
}

const p95Expr = `histogram_quantile(0.95, sum by (le) (rate(nekocafe_http_server_duration_ms_bucket{service_name="reservation-service",release_channel="canary"}[${WINDOW}])))`;
const errorRateExpr = `sum(rate(nekocafe_http_server_requests_total{service_name="reservation-service",release_channel="canary",status_code=~"5.."}[${WINDOW}])) / clamp_min(sum(rate(nekocafe_http_server_requests_total{service_name="reservation-service",release_channel="canary"}[${WINDOW}])), 0.0001)`;

async function tick() {
  const [p95, errorRate] = await Promise.all([query(p95Expr), query(errorRateExpr)]);
  console.log(`[watch-canary] p95=${p95}ms errorRate=${errorRate}`);

  if (!Number.isNaN(p95) && p95 > P95_THRESHOLD_MS) {
    console.log("[watch-canary] p95 threshold breached, triggering rollback");
    await rollback();
    process.exit(0);
  }

  if (!Number.isNaN(errorRate) && errorRate > ERROR_RATE_THRESHOLD) {
    console.log("[watch-canary] error-rate threshold breached, triggering rollback");
    await rollback();
    process.exit(0);
  }
}

setInterval(() => {
  tick().catch((error) => {
    console.error("[watch-canary]", error.message);
  });
}, POLL_INTERVAL_MS);

tick().catch((error) => {
  console.error("[watch-canary]", error.message);
});
