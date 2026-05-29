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

function createRepository(overrides = {}) {
  return {
    isReady: async () => true,
    getProfile: async () => null,
    updatePreferences: async () => null,
    listBenefits: async () => [],
    redeemBenefit: async () => null,
    listPointsLedger: async () => ({
      data: [],
      page: { page: 1, size: 20, total: 0, hasNext: false },
    }),
    createPrivacyExport: async () => null,
    createPrivacyDelete: async () => null,
    recordOutboxEvent: async () => undefined,
    ...overrides,
  };
}

function createRedis(overrides = {}) {
  return {
    ping: async () => "PONG",
    ...overrides,
  };
}

async function withServer(options, run) {
  const app = createApp({
    logger: createLogger(),
    repository: createRepository(options.repository),
    redis: createRedis(options.redis),
    authMiddleware: (_req, _res, next) => next(),
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  return { response, payload };
}

test("healthz returns 200 for member service", async () => {
  await withServer({}, async (baseUrl) => {
    const { response, payload } = await requestJson(baseUrl, "/healthz");
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ok");
  });
});

test("get member profile returns seeded shape", async () => {
  const profile = {
    memberId: "MEM-220501208",
    customerId: "CUS-10086",
    nickname: "NekoFan",
    phoneMasked: "138****4567",
    tier: "gold",
    pointsBalance: 1680,
    preferredStoreId: "STORE-BJ-001",
    preferenceTags: ["quiet-seat", "orange-cat"],
    joinedAt: "2026-05-10T10:00:00Z",
  };

  await withServer(
    { repository: { getProfile: async () => profile } },
    async (baseUrl) => {
      const { response, payload } = await requestJson(baseUrl, "/member/v1/members/MEM-220501208");
      assert.equal(response.status, 200);
      assert.equal(payload.memberId, "MEM-220501208");
      assert.equal(payload.tier, "gold");
    }
  );
});

test("update preferences returns updated profile", async () => {
  await withServer(
    {
      repository: {
        updatePreferences: async () => ({
          memberId: "MEM-220501208",
          customerId: "CUS-10086",
          nickname: "NekoFan",
          phoneMasked: "138****4567",
          tier: "gold",
          pointsBalance: 1680,
          preferredStoreId: "STORE-BJ-002",
          preferenceTags: ["window-seat", "ragdoll"],
          joinedAt: "2026-05-10T10:00:00Z",
        }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/member/v1/members/MEM-220501208/preferences",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            preferredStoreId: "STORE-BJ-002",
            preferenceTags: ["window-seat", "ragdoll"],
          }),
        }
      );

      assert.equal(response.status, 200);
      assert.equal(payload.preferredStoreId, "STORE-BJ-002");
      assert.deepEqual(payload.preferenceTags, ["window-seat", "ragdoll"]);
    }
  );
});

test("list benefits returns benefit collection", async () => {
  await withServer(
    {
      repository: {
        listBenefits: async () => [
          {
            benefitId: "BEN-COUPON-88",
            title: "Birthday Dessert",
            status: "available",
            expiresAt: "2026-05-25T00:00:00Z",
          },
        ],
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(baseUrl, "/member/v1/members/MEM-220501208/benefits");
      assert.equal(response.status, 200);
      assert.equal(payload.data.length, 1);
      assert.equal(payload.data[0].benefitId, "BEN-COUPON-88");
    }
  );
});

test("redeem benefit returns updated balance", async () => {
  await withServer(
    {
      repository: {
        redeemBenefit: async () => ({
          benefitId: "BEN-COUPON-88",
          status: "used",
          redeemedAt: "2026-05-10T12:00:00Z",
          pointsBalance: 1600,
        }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/member/v1/members/MEM-220501208/benefits/redeem",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            benefitId: "BEN-COUPON-88",
            reservationId: "RSV-20260510-0001",
            redeemedBy: "staff-001",
          }),
        }
      );

      assert.equal(response.status, 200);
      assert.equal(payload.status, "used");
      assert.equal(payload.pointsBalance, 1600);
    }
  );
});

test("points ledger returns paginated ledger items", async () => {
  await withServer(
    {
      repository: {
        listPointsLedger: async () => ({
          data: [
            {
              ledgerId: "PTS-20260508-0001",
              delta: 120,
              reason: "reservation_completed",
              occurredAt: "2026-05-08T10:00:00Z",
            },
          ],
          page: { page: 1, size: 20, total: 1, hasNext: false },
        }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/member/v1/members/MEM-220501208/points-ledger?page=1&size=20"
      );
      assert.equal(response.status, 200);
      assert.equal(payload.data.length, 1);
      assert.equal(payload.page.total, 1);
    }
  );
});

test("privacy export request returns 202", async () => {
  await withServer(
    {
      repository: {
        createPrivacyExport: async () => ({
          requestId: "PRIV-EXP-20260510-0001",
          status: "accepted",
          expectedReadyAt: "2026-05-11T12:00:00Z",
        }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/member/v1/members/MEM-220501208/privacy/export",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deliveryChannel: "email",
            language: "zh-CN",
          }),
        }
      );

      assert.equal(response.status, 202);
      assert.equal(payload.status, "accepted");
    }
  );
});

test("privacy delete request returns 202", async () => {
  await withServer(
    {
      repository: {
        createPrivacyDelete: async () => ({
          requestId: "PRIV-DEL-20260510-0001",
          status: "scheduled",
        }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/member/v1/members/MEM-220501208/privacy",
        { method: "DELETE" }
      );

      assert.equal(response.status, 202);
      assert.equal(payload.status, "scheduled");
    }
  );
});
