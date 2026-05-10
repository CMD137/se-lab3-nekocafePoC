const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createApp } = require("../src/index.js");

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("healthz returns 200 for member service", async () => {
  const app = createApp({
    logger: createLogger(),
    repository: {
      isReady: async () => true,
      getProfile: async () => null,
      updatePreferences: async () => null,
      listBenefits: async () => [],
      redeemBenefit: async () => null,
      listPointsLedger: async () => ({ data: [], page: { page: 1, size: 20, total: 0, hasNext: false } }),
      createPrivacyExport: async () => null,
      createPrivacyDelete: async () => null,
      recordOutboxEvent: async () => undefined,
    },
    redis: {
      ping: async () => "PONG",
    },
    authMiddleware: (_req, _res, next) => next(),
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("get member profile returns seeded shape", async () => {
  const profile = {
    memberId: "MEM-220501208",
    customerId: "CUS-10086",
    nickname: "NekoFan",
    phoneMasked: "138****4567",
    tier: "gold",
    pointsBalance: 1680,
    preferenceTags: ["quiet-seat", "orange-cat"],
    joinedAt: "2026-05-10T10:00:00Z",
  };

  const app = createApp({
    logger: createLogger(),
    repository: {
      isReady: async () => true,
      getProfile: async () => profile,
      updatePreferences: async () => profile,
      listBenefits: async () => [],
      redeemBenefit: async () => null,
      listPointsLedger: async () => ({ data: [], page: { page: 1, size: 20, total: 0, hasNext: false } }),
      createPrivacyExport: async () => null,
      createPrivacyDelete: async () => null,
      recordOutboxEvent: async () => undefined,
    },
    redis: {
      ping: async () => "PONG",
    },
    authMiddleware: (_req, _res, next) => next(),
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/member/v1/members/MEM-220501208`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.memberId, "MEM-220501208");
    assert.equal(payload.tier, "gold");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
