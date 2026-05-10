const express = require("express");
const jwt = require("jsonwebtoken");
const pino = require("pino");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { createClient } = require("redis");

const SERVICE_NAME = process.env.SERVICE_NAME || "reservation-service";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const API_PREFIX = "/reservation/v1";

class AppError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function createLogger() {
  return pino({
    name: SERVICE_NAME,
    level: process.env.ACCESS_LOG_LEVEL || "info",
  });
}

function createAuthMiddleware(secret) {
  return (req, _res, next) => {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";

    if (!token) {
      next(new AppError(401, "UNAUTHORIZED", "Missing bearer token."));
      return;
    }

    try {
      req.user = jwt.verify(token, secret);
      next();
    } catch (error) {
      next(new AppError(401, "UNAUTHORIZED", "Token is invalid or expired.", [error.message]));
    }
  };
}

function requestContext(logger) {
  return (req, res, next) => {
    req.traceId = req.headers["x-trace-id"] || randomUUID();
    res.setHeader("x-trace-id", req.traceId);

    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info({
        traceId: req.traceId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  };
}

function requireFields(payload, fields) {
  const missing = fields.filter((field) => payload[field] === undefined || payload[field] === null);
  if (missing.length > 0) {
    throw new AppError(400, "BAD_REQUEST", "Required fields are missing.", missing);
  }
}

function toPageMeta(page, size, total) {
  return {
    page,
    size,
    total,
    hasNext: page * size < total,
  };
}

function createRepository(pool, schema) {
  const qualified = (table) => `${schema}.${table}`;

  async function init() {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualified("reservations")} (
        reservation_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        table_id TEXT,
        party_size INTEGER NOT NULL,
        seat_preference TEXT,
        status TEXT NOT NULL,
        lock_expires_at TIMESTAMPTZ,
        special_requests TEXT,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualified("waitlist_entries")} (
        waitlist_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        party_size INTEGER NOT NULL,
        date DATE NOT NULL,
        seat_preference TEXT,
        notify_channel TEXT,
        rank INTEGER NOT NULL,
        estimated_notify_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualified("outbox_events")} (
        event_id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        bus_name TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async function isReady() {
    await pool.query("SELECT 1");
    return true;
  }

  async function listReservations({ page, size, customerId, storeId, status }) {
    const where = [];
    const values = [];
    let index = 1;

    if (customerId) {
      where.push(`customer_id = $${index++}`);
      values.push(customerId);
    }
    if (storeId) {
      where.push(`store_id = $${index++}`);
      values.push(storeId);
    }
    if (status) {
      where.push(`status = $${index++}`);
      values.push(status);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limitIndex = index++;
    const offsetIndex = index++;
    values.push(size, (page - 1) * size);

    const listResult = await pool.query(
      `
        SELECT reservation_id, customer_id, store_id, table_id, party_size, seat_preference, status, lock_expires_at,
               special_requests, start_time, end_time, created_at, updated_at
        FROM ${qualified("reservations")}
        ${clause}
        ORDER BY created_at DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      values
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total FROM ${qualified("reservations")} ${clause}`,
      values.slice(0, values.length - 2)
    );

    return {
      data: listResult.rows.map(mapReservation),
      page: toPageMeta(page, size, countResult.rows[0].total),
    };
  }

  async function getReservationById(reservationId) {
    const result = await pool.query(
      `
        SELECT reservation_id, customer_id, store_id, table_id, party_size, seat_preference, status, lock_expires_at,
               special_requests, start_time, end_time, created_at, updated_at
        FROM ${qualified("reservations")}
        WHERE reservation_id = $1
      `,
      [reservationId]
    );
    return result.rows[0] ? mapReservation(result.rows[0]) : null;
  }

  async function createReservation(payload) {
    const reservation = {
      reservationId: `RSV-${Date.now()}`,
      customerId: payload.customerId,
      storeId: payload.storeId,
      tableId: `T-${payload.partySize}-A`,
      partySize: payload.partySize,
      seatPreference: payload.seatPreference || "standard",
      status: "pending",
      lockExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      specialRequests: payload.specialRequests || null,
      timeSlot: payload.timeSlot,
    };

    await pool.query(
      `
        INSERT INTO ${qualified("reservations")}
          (reservation_id, customer_id, store_id, table_id, party_size, seat_preference, status, lock_expires_at,
           special_requests, start_time, end_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        reservation.reservationId,
        reservation.customerId,
        reservation.storeId,
        reservation.tableId,
        reservation.partySize,
        reservation.seatPreference,
        reservation.status,
        reservation.lockExpiresAt,
        reservation.specialRequests,
        reservation.timeSlot.startTime,
        reservation.timeSlot.endTime,
      ]
    );

    return getReservationById(reservation.reservationId);
  }

  async function updateReservation(reservationId, mutator) {
    const current = await getReservationById(reservationId);
    if (!current) {
      return null;
    }

    const nextState = mutator(current);
    await pool.query(
      `
        UPDATE ${qualified("reservations")}
        SET table_id = $2,
            seat_preference = $3,
            status = $4,
            lock_expires_at = $5,
            special_requests = $6,
            start_time = $7,
            end_time = $8,
            updated_at = NOW()
        WHERE reservation_id = $1
      `,
      [
        reservationId,
        nextState.tableId,
        nextState.seatPreference,
        nextState.status,
        nextState.lockExpiresAt,
        nextState.specialRequests,
        nextState.timeSlot.startTime,
        nextState.timeSlot.endTime,
      ]
    );

    return getReservationById(reservationId);
  }

  async function createWaitlistEntry(payload) {
    const waitlist = {
      waitlistId: `WL-${Date.now()}`,
      customerId: payload.customerId,
      storeId: payload.storeId,
      rank: Math.floor(Math.random() * 4) + 1,
      estimatedNotifyAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    await pool.query(
      `
        INSERT INTO ${qualified("waitlist_entries")}
          (waitlist_id, customer_id, store_id, party_size, date, seat_preference, notify_channel, rank, estimated_notify_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        waitlist.waitlistId,
        payload.customerId,
        payload.storeId,
        payload.partySize,
        payload.date,
        payload.seatPreference || "standard",
        payload.notifyChannel || "app-push",
        waitlist.rank,
        waitlist.estimatedNotifyAt,
      ]
    );

    return waitlist;
  }

  async function recordOutboxEvent(aggregateId, eventName, payload) {
    await pool.query(
      `
        INSERT INTO ${qualified("outbox_events")}
          (event_id, aggregate_id, event_name, bus_name, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [randomUUID(), aggregateId, eventName, process.env.EVENT_BUS_NAME || "rocketmq", JSON.stringify(payload)]
    );
  }

  function mapReservation(row) {
    return {
      reservationId: row.reservation_id,
      customerId: row.customer_id,
      storeId: row.store_id,
      tableId: row.table_id,
      partySize: row.party_size,
      seatPreference: row.seat_preference,
      status: row.status,
      lockExpiresAt: row.lock_expires_at ? row.lock_expires_at.toISOString() : null,
      specialRequests: row.special_requests,
      timeSlot: {
        startTime: row.start_time.toISOString(),
        endTime: row.end_time.toISOString(),
      },
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  return {
    init,
    isReady,
    listReservations,
    getReservationById,
    createReservation,
    updateReservation,
    createWaitlistEntry,
    recordOutboxEvent,
  };
}

async function buildDependencies(logger) {
  const pool = new Pool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "nekocafe",
    user: process.env.DB_USER || "nekocafe",
    password: process.env.DB_PASSWORD || "nekocafe-dev-password",
  });
  const redis = createClient({
    url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  });
  redis.on("error", (error) => {
    logger.warn({ err: error.message }, "redis client error");
  });
  await redis.connect();

  const repository = createRepository(pool, process.env.DB_SCHEMA || "reservation");
  await repository.init();

  return { pool, redis, repository };
}

function createApp({ logger, repository, redis, authMiddleware }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext(logger));

  app.get("/healthz", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/readyz", async (_req, res, next) => {
    try {
      await repository.isReady();
      await redis.ping();
      res.json({
        service: SERVICE_NAME,
        status: "ready",
      });
    } catch (error) {
      next(new AppError(503, "NOT_READY", "Service dependencies are not ready.", [error.message]));
    }
  });

  const router = express.Router();
  router.use(authMiddleware);

  router.get("/availability", async (req, res, next) => {
    try {
      requireFields(req.query, ["storeId", "date", "partySize"]);
      const cacheKey = `availability:${req.query.storeId}:${req.query.date}:${req.query.partySize}:${req.query.seatPreference || "standard"}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const response = {
        storeId: req.query.storeId,
        date: req.query.date,
        slots: [
          {
            tableType: "two-seat",
            remainingTables: 4,
            seatPreference: req.query.seatPreference || "standard",
            timeSlot: {
              startTime: `${req.query.date}T10:30:00Z`,
              endTime: `${req.query.date}T12:00:00Z`,
            },
          },
          {
            tableType: "four-seat",
            remainingTables: 3,
            seatPreference: req.query.seatPreference || "standard",
            timeSlot: {
              startTime: `${req.query.date}T12:30:00Z`,
              endTime: `${req.query.date}T14:00:00Z`,
            },
          },
          {
            tableType: "window-seat",
            remainingTables: 2,
            seatPreference: req.query.seatPreference || "standard",
            timeSlot: {
              startTime: `${req.query.date}T18:00:00Z`,
              endTime: `${req.query.date}T19:30:00Z`,
            },
          },
        ],
      };

      await redis.set(cacheKey, JSON.stringify(response), { EX: 60 });
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/reservations", async (req, res, next) => {
    try {
      const page = Number.parseInt(req.query.page || "1", 10);
      const size = Number.parseInt(req.query.size || "20", 10);
      const result = await repository.listReservations({
        page,
        size,
        customerId: req.query.customerId,
        storeId: req.query.storeId,
        status: req.query.status,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/reservations", async (req, res, next) => {
    try {
      requireFields(req.body, ["customerId", "storeId", "partySize", "timeSlot"]);
      requireFields(req.body.timeSlot, ["startTime", "endTime"]);
      const lockKey = `reservation-lock:${req.body.storeId}:${req.body.timeSlot.startTime}:${req.body.partySize}`;
      const acquired = await redis.set(lockKey, req.body.customerId, { NX: true, EX: 300 });
      if (!acquired) {
        throw new AppError(409, "RESERVATION_CONFLICT", "Requested table is no longer available.");
      }

      const reservation = await repository.createReservation(req.body);
      await repository.recordOutboxEvent(reservation.reservationId, "reservation.created", {
        traceId: req.traceId,
        reservationId: reservation.reservationId,
        customerId: reservation.customerId,
      });
      res.status(201).json(reservation);
    } catch (error) {
      next(error);
    }
  });

  router.get("/reservations/:reservationId", async (req, res, next) => {
    try {
      const reservation = await repository.getReservationById(req.params.reservationId);
      if (!reservation) {
        throw new AppError(404, "NOT_FOUND", "Reservation was not found.");
      }
      res.json(reservation);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/reservations/:reservationId/confirm", async (req, res, next) => {
    try {
      const reservation = await repository.updateReservation(req.params.reservationId, (current) => {
        if (!["pending", "waitlisted"].includes(current.status)) {
          throw new AppError(409, "RESERVATION_CONFLICT", "Reservation cannot be confirmed from current status.");
        }
        return {
          ...current,
          status: "confirmed",
        };
      });
      if (!reservation) {
        throw new AppError(404, "NOT_FOUND", "Reservation was not found.");
      }
      await repository.recordOutboxEvent(reservation.reservationId, "reservation.confirmed", {
        traceId: req.traceId,
        reservationId: reservation.reservationId,
      });
      res.json(reservation);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/reservations/:reservationId/cancel", async (req, res, next) => {
    try {
      requireFields(req.body, ["reason"]);
      const reservation = await repository.updateReservation(req.params.reservationId, (current) => {
        if (current.status === "cancelled") {
          throw new AppError(409, "RESERVATION_CONFLICT", "Reservation is already cancelled.");
        }
        return {
          ...current,
          status: "cancelled",
          lockExpiresAt: null,
        };
      });
      if (!reservation) {
        throw new AppError(404, "NOT_FOUND", "Reservation was not found.");
      }
      const lockKey = `reservation-lock:${reservation.storeId}:${reservation.timeSlot.startTime}:${reservation.partySize}`;
      await redis.del(lockKey);
      await repository.recordOutboxEvent(reservation.reservationId, "reservation.cancelled", {
        traceId: req.traceId,
        reservationId: reservation.reservationId,
        reason: req.body.reason,
      });
      res.json(reservation);
    } catch (error) {
      next(error);
    }
  });

  router.post("/reservations/:reservationId/reschedule", async (req, res, next) => {
    try {
      requireFields(req.body, ["timeSlot"]);
      requireFields(req.body.timeSlot, ["startTime", "endTime"]);
      const reservation = await repository.getReservationById(req.params.reservationId);
      if (!reservation) {
        throw new AppError(404, "NOT_FOUND", "Reservation was not found.");
      }

      const nextLockKey = `reservation-lock:${reservation.storeId}:${req.body.timeSlot.startTime}:${reservation.partySize}`;
      const acquired = await redis.set(nextLockKey, reservation.customerId, { NX: true, EX: 300 });
      if (!acquired) {
        throw new AppError(409, "RESERVATION_CONFLICT", "Target slot is no longer available.");
      }

      const currentLockKey = `reservation-lock:${reservation.storeId}:${reservation.timeSlot.startTime}:${reservation.partySize}`;
      await redis.del(currentLockKey);

      const updated = await repository.updateReservation(req.params.reservationId, (current) => ({
        ...current,
        seatPreference: req.body.seatPreference || current.seatPreference,
        lockExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        timeSlot: req.body.timeSlot,
      }));

      await repository.recordOutboxEvent(updated.reservationId, "reservation.rescheduled", {
        traceId: req.traceId,
        reservationId: updated.reservationId,
        timeSlot: req.body.timeSlot,
      });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.post("/reservations/:reservationId/check-in", async (req, res, next) => {
    try {
      requireFields(req.body, ["verificationCode", "checkedInBy"]);
      const reservation = await repository.updateReservation(req.params.reservationId, (current) => {
        if (current.status !== "confirmed") {
          throw new AppError(409, "RESERVATION_CONFLICT", "Reservation must be confirmed before check-in.");
        }
        return {
          ...current,
          status: "checked-in",
        };
      });
      if (!reservation) {
        throw new AppError(404, "NOT_FOUND", "Reservation was not found.");
      }
      await repository.recordOutboxEvent(reservation.reservationId, "reservation.checked_in", {
        traceId: req.traceId,
        reservationId: reservation.reservationId,
        checkedInBy: req.body.checkedInBy,
      });
      res.json(reservation);
    } catch (error) {
      next(error);
    }
  });

  router.post("/waitlist", async (req, res, next) => {
    try {
      requireFields(req.body, ["customerId", "storeId", "partySize", "date"]);
      const entry = await repository.createWaitlistEntry(req.body);
      await repository.recordOutboxEvent(entry.waitlistId, "reservation.waitlist.created", {
        traceId: req.traceId,
        waitlistId: entry.waitlistId,
        customerId: entry.customerId,
      });
      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  });

  app.use(API_PREFIX, router);

  app.use((req, _res, next) => {
    next(new AppError(404, "NOT_FOUND", "The requested resource does not exist."));
  });

  app.use((error, req, res, _next) => {
    const status = error.status || 500;
    const code = error.code || "INTERNAL_ERROR";
    const payload = {
      code,
      message: error.message || "Unexpected error.",
      traceId: req.traceId || randomUUID(),
      details: error.details || [],
    };

    if (status >= 500) {
      logger.error({ err: error, traceId: payload.traceId }, "request failed");
    }

    res.status(status).json(payload);
  });

  return app;
}

async function start() {
  const logger = createLogger();
  const dependencies = await buildDependencies(logger);
  const app = createApp({
    logger,
    repository: dependencies.repository,
    redis: dependencies.redis,
    authMiddleware: createAuthMiddleware(process.env.JWT_SECRET || "replace-me-in-env"),
  });

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "reservation service listening");
  });

  async function shutdown(signal) {
    logger.info({ signal }, "shutting down reservation service");
    server.close(async () => {
      await dependencies.redis.quit();
      await dependencies.pool.end();
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  start().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  AppError,
  createApp,
  createAuthMiddleware,
  createLogger,
  createRepository,
  requireFields,
  toPageMeta,
};
