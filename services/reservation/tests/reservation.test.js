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

function createRepository(overrides = {}) {
  return {
    isReady: async () => true,
    listReservations: async () => ({
      data: [],
      page: { page: 1, size: 20, total: 0, hasNext: false },
    }),
    getReservationById: async () => null,
    createReservation: async () => null,
    updateReservation: async () => null,
    createWaitlistEntry: async () => null,
    recordOutboxEvent: async () => undefined,
    ...overrides,
  };
}

function createRedis(overrides = {}) {
  return {
    ping: async () => "PONG",
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
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

test("healthz returns 200 for reservation service", async () => {
  await withServer({}, async (baseUrl) => {
    const { response, payload } = await requestJson(baseUrl, "/healthz");
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ok");
  });
});

test("availability returns generated slot list", async () => {
  await withServer({}, async (baseUrl) => {
    const { response, payload } = await requestJson(
      baseUrl,
      "/reservation/v1/availability?storeId=STORE-BJ-001&date=2026-05-10&partySize=4"
    );

    assert.equal(response.status, 200);
    assert.equal(payload.storeId, "STORE-BJ-001");
    assert.equal(payload.slots.length, 3);
  });
});

test("list reservations returns paginated payload", async () => {
  const reservations = [
    {
      reservationId: "RSV-20260510-0001",
      customerId: "CUS-10086",
      storeId: "STORE-BJ-001",
      tableId: "T-4-A",
      partySize: 4,
      seatPreference: "quiet",
      status: "confirmed",
      lockExpiresAt: null,
      specialRequests: null,
      timeSlot: {
        startTime: "2026-05-10T10:30:00Z",
        endTime: "2026-05-10T12:00:00Z",
      },
      createdAt: "2026-05-10T10:00:00Z",
      updatedAt: "2026-05-10T10:10:00Z",
    },
  ];

  await withServer(
    {
      repository: {
        listReservations: async () => ({
          data: reservations,
          page: { page: 1, size: 20, total: 1, hasNext: false },
        }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(baseUrl, "/reservation/v1/reservations?page=1&size=20");
      assert.equal(response.status, 200);
      assert.equal(payload.data.length, 1);
      assert.equal(payload.data[0].status, "confirmed");
      assert.equal(payload.page.total, 1);
    }
  );
});

test("get reservation by id returns 404 when missing", async () => {
  await withServer({}, async (baseUrl) => {
    const { response, payload } = await requestJson(baseUrl, "/reservation/v1/reservations/RSV-MISSING");
    assert.equal(response.status, 404);
    assert.equal(payload.code, "NOT_FOUND");
  });
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

  await withServer(
    {
      repository: {
        createReservation: async () => createdReservation,
        updateReservation: async () => createdReservation,
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(baseUrl, "/reservation/v1/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
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

      assert.equal(response.status, 201);
      assert.equal(payload.reservationId, "RSV-20260510-0001");
      assert.equal(payload.status, "pending");
    }
  );
});

test("confirm reservation transitions to confirmed", async () => {
  await withServer(
    {
      repository: {
        updateReservation: async (_reservationId, mutator) =>
          mutator({
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
          }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/reservation/v1/reservations/RSV-20260510-0001/confirm",
        { method: "PATCH" }
      );

      assert.equal(response.status, 200);
      assert.equal(payload.status, "confirmed");
    }
  );
});

test("cancel reservation clears lock and returns cancelled status", async () => {
  await withServer(
    {
      repository: {
        updateReservation: async (_reservationId, mutator) =>
          mutator({
            reservationId: "RSV-20260510-0001",
            customerId: "CUS-10086",
            storeId: "STORE-BJ-001",
            tableId: "T-4-A",
            partySize: 4,
            seatPreference: "quiet",
            status: "confirmed",
            lockExpiresAt: "2026-05-10T10:35:00Z",
            specialRequests: null,
            timeSlot: {
              startTime: "2026-05-10T10:30:00Z",
              endTime: "2026-05-10T12:00:00Z",
            },
            createdAt: "2026-05-10T10:00:00Z",
            updatedAt: "2026-05-10T10:00:00Z",
          }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/reservation/v1/reservations/RSV-20260510-0001/cancel",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "user-requested" }),
        }
      );

      assert.equal(response.status, 200);
      assert.equal(payload.status, "cancelled");
      assert.equal(payload.lockExpiresAt, null);
    }
  );
});

test("reschedule reservation updates the slot", async () => {
  await withServer(
    {
      repository: {
        getReservationById: async () => ({
          reservationId: "RSV-20260510-0001",
          customerId: "CUS-10086",
          storeId: "STORE-BJ-001",
          tableId: "T-4-A",
          partySize: 4,
          seatPreference: "quiet",
          status: "confirmed",
          lockExpiresAt: "2026-05-10T10:35:00Z",
          specialRequests: null,
          timeSlot: {
            startTime: "2026-05-10T10:30:00Z",
            endTime: "2026-05-10T12:00:00Z",
          },
          createdAt: "2026-05-10T10:00:00Z",
          updatedAt: "2026-05-10T10:00:00Z",
        }),
        updateReservation: async (_reservationId, mutator) =>
          mutator({
            reservationId: "RSV-20260510-0001",
            customerId: "CUS-10086",
            storeId: "STORE-BJ-001",
            tableId: "T-4-A",
            partySize: 4,
            seatPreference: "quiet",
            status: "confirmed",
            lockExpiresAt: "2026-05-10T10:35:00Z",
            specialRequests: null,
            timeSlot: {
              startTime: "2026-05-10T10:30:00Z",
              endTime: "2026-05-10T12:00:00Z",
            },
            createdAt: "2026-05-10T10:00:00Z",
            updatedAt: "2026-05-10T10:00:00Z",
          }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/reservation/v1/reservations/RSV-20260510-0001/reschedule",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seatPreference: "window-seat",
            timeSlot: {
              startTime: "2026-05-10T18:00:00Z",
              endTime: "2026-05-10T19:30:00Z",
            },
          }),
        }
      );

      assert.equal(response.status, 200);
      assert.equal(payload.seatPreference, "window-seat");
      assert.equal(payload.timeSlot.startTime, "2026-05-10T18:00:00Z");
    }
  );
});

test("check-in requires confirmed reservation and returns checked-in status", async () => {
  await withServer(
    {
      repository: {
        updateReservation: async (_reservationId, mutator) =>
          mutator({
            reservationId: "RSV-20260510-0001",
            customerId: "CUS-10086",
            storeId: "STORE-BJ-001",
            tableId: "T-4-A",
            partySize: 4,
            seatPreference: "quiet",
            status: "confirmed",
            lockExpiresAt: "2026-05-10T10:35:00Z",
            specialRequests: null,
            timeSlot: {
              startTime: "2026-05-10T10:30:00Z",
              endTime: "2026-05-10T12:00:00Z",
            },
            createdAt: "2026-05-10T10:00:00Z",
            updatedAt: "2026-05-10T10:00:00Z",
          }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(
        baseUrl,
        "/reservation/v1/reservations/RSV-20260510-0001/check-in",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            verificationCode: "CHECKIN-001",
            checkedInBy: "staff-001",
          }),
        }
      );

      assert.equal(response.status, 200);
      assert.equal(payload.status, "checked-in");
    }
  );
});

test("create waitlist entry returns 201", async () => {
  await withServer(
    {
      repository: {
        createWaitlistEntry: async () => ({
          waitlistId: "WL-20260510-0001",
          customerId: "CUS-10086",
          storeId: "STORE-BJ-001",
          rank: 2,
          estimatedNotifyAt: "2026-05-10T12:30:00Z",
        }),
      },
    },
    async (baseUrl) => {
      const { response, payload } = await requestJson(baseUrl, "/reservation/v1/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: "CUS-10086",
          storeId: "STORE-BJ-001",
          partySize: 4,
          date: "2026-05-10",
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(payload.waitlistId, "WL-20260510-0001");
      assert.equal(payload.rank, 2);
    }
  );
});
