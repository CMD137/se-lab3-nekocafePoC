const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createApp } = require("../src/main.js");

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("healthz returns 200 for reservation service", async () => {
  const app = createApp({
    logger: createLogger(),
    repository: {
      isReady: async () => true,
      listReservations: async () => ({ data: [], page: { page: 1, size: 20, total: 0, hasNext: false } }),
      getReservationById: async () => null,
      createReservation: async () => null,
      updateReservation: async () => null,
      createWaitlistEntry: async () => null,
      recordOutboxEvent: async () => undefined,
    },
    redis: {
      ping: async () => "PONG",
      get: async () => null,
      set: async () => "OK",
      del: async () => 1,
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

test("create reservation returns 201 with normalized payload", async () => {
  const createdReservation = {
    reservationId: "RSV-20260510-0001",
    customerId: "CUS-10086",
    storeId: "STORE-BJ-001",
    tableId: "T-4-A",
    partySize: 4,
    seatPreference: "quiet",
    status: "pending",
    lockExpiresAt: "2026-05-10T10:35:00Z",
    specialRequests: null,
    timeSlot: {
      startTime: "2026-05-10T10:30:00Z",
      endTime: "2026-05-10T12:00:00Z",
    },
    createdAt: "2026-05-10T10:00:00Z",
    updatedAt: "2026-05-10T10:00:00Z",
  };

  const app = createApp({
    logger: createLogger(),
    repository: {
      isReady: async () => true,
      listReservations: async () => ({ data: [], page: { page: 1, size: 20, total: 0, hasNext: false } }),
      getReservationById: async () => null,
      createReservation: async () => createdReservation,
      updateReservation: async () => createdReservation,
      createWaitlistEntry: async () => null,
      recordOutboxEvent: async () => undefined,
    },
    redis: {
      ping: async () => "PONG",
      get: async () => null,
      set: async () => "OK",
      del: async () => 1,
    },
    authMiddleware: (_req, _res, next) => next(),
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/reservation/v1/reservations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customerId: "CUS-10086",
        storeId: "STORE-BJ-001",
        partySize: 4,
        seatPreference: "quiet",
        timeSlot: {
          startTime: "2026-05-10T10:30:00Z",
          endTime: "2026-05-10T12:00:00Z",
        },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.reservationId, "RSV-20260510-0001");
    assert.equal(payload.status, "pending");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
