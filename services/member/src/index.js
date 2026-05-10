const express = require("express");
const jwt = require("jsonwebtoken");
const pino = require("pino");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { createClient } = require("redis");

const SERVICE_NAME = process.env.SERVICE_NAME || "member-service";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const API_PREFIX = "/member/v1";

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
      CREATE TABLE IF NOT EXISTS ${qualified("member_profiles")} (
        member_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        phone_masked TEXT NOT NULL,
        tier TEXT NOT NULL,
        points_balance INTEGER NOT NULL,
        preferred_store_id TEXT,
        preference_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualified("member_benefits")} (
        benefit_id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualified("points_ledger")} (
        ledger_id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualified("privacy_requests")} (
        request_id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        request_type TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_channel TEXT,
        language TEXT,
        expected_ready_at TIMESTAMPTZ,
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

    await seed();
  }

  async function seed() {
    await pool.query(
      `
        INSERT INTO ${qualified("member_profiles")}
          (member_id, customer_id, nickname, phone_masked, tier, points_balance, preferred_store_id, preference_tags)
        VALUES
          ('MEM-220501208', 'CUS-10086', 'NekoFan', '138****4567', 'gold', 1680, 'STORE-BJ-001', ARRAY['quiet-seat', 'orange-cat', 'seafood'])
        ON CONFLICT (member_id) DO NOTHING
      `
    );

    await pool.query(
      `
        INSERT INTO ${qualified("member_benefits")}
          (benefit_id, member_id, title, status, expires_at)
        VALUES
          ('BEN-COUPON-88', 'MEM-220501208', 'Birthday Dessert', 'available', NOW() + INTERVAL '15 day'),
          ('BEN-DRINK-01', 'MEM-220501208', 'Cat Latte Upgrade', 'available', NOW() + INTERVAL '30 day')
        ON CONFLICT (benefit_id) DO NOTHING
      `
    );

    await pool.query(
      `
        INSERT INTO ${qualified("points_ledger")}
          (ledger_id, member_id, delta, reason)
        VALUES
          ('PTS-20260508-0001', 'MEM-220501208', 120, 'reservation_completed'),
          ('PTS-20260508-0002', 'MEM-220501208', 80, 'benefit_bonus')
        ON CONFLICT (ledger_id) DO NOTHING
      `
    );
  }

  async function isReady() {
    await pool.query("SELECT 1");
    return true;
  }

  async function getProfile(memberId) {
    const result = await pool.query(
      `
        SELECT member_id, customer_id, nickname, phone_masked, tier, points_balance, preferred_store_id,
               preference_tags, joined_at
        FROM ${qualified("member_profiles")}
        WHERE member_id = $1
      `,
      [memberId]
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async function updatePreferences(memberId, payload) {
    const result = await pool.query(
      `
        UPDATE ${qualified("member_profiles")}
        SET preference_tags = $2,
            preferred_store_id = COALESCE($3, preferred_store_id)
        WHERE member_id = $1
        RETURNING member_id, customer_id, nickname, phone_masked, tier, points_balance, preferred_store_id,
                  preference_tags, joined_at
      `,
      [memberId, payload.preferenceTags, payload.preferredStoreId || null]
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async function listBenefits(memberId) {
    const result = await pool.query(
      `
        SELECT benefit_id, title, status, expires_at
        FROM ${qualified("member_benefits")}
        WHERE member_id = $1
        ORDER BY expires_at ASC
      `,
      [memberId]
    );
    return result.rows.map((row) => ({
      benefitId: row.benefit_id,
      title: row.title,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
    }));
  }

  async function redeemBenefit(memberId, payload) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const benefit = await client.query(
        `
          SELECT benefit_id, status
          FROM ${qualified("member_benefits")}
          WHERE benefit_id = $1 AND member_id = $2
          FOR UPDATE
        `,
        [payload.benefitId, memberId]
      );

      if (benefit.rowCount === 0) {
        throw new AppError(404, "NOT_FOUND", "Benefit was not found.");
      }
      if (benefit.rows[0].status !== "available") {
        throw new AppError(409, "BENEFIT_CONFLICT", "Benefit is not available.");
      }

      await client.query(
        `
          UPDATE ${qualified("member_benefits")}
          SET status = 'used'
          WHERE benefit_id = $1
        `,
        [payload.benefitId]
      );

      const profile = await client.query(
        `
          UPDATE ${qualified("member_profiles")}
          SET points_balance = GREATEST(points_balance - 80, 0)
          WHERE member_id = $1
          RETURNING points_balance
        `,
        [memberId]
      );

      await client.query(
        `
          INSERT INTO ${qualified("points_ledger")}
            (ledger_id, member_id, delta, reason)
          VALUES ($1, $2, $3, $4)
        `,
        [randomUUID(), memberId, -80, "benefit_redeemed"]
      );

      await client.query("COMMIT");

      return {
        benefitId: payload.benefitId,
        status: "used",
        redeemedAt: new Date().toISOString(),
        pointsBalance: profile.rows[0].points_balance,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function listPointsLedger(memberId, page, size) {
    const offset = (page - 1) * size;
    const dataResult = await pool.query(
      `
        SELECT ledger_id, delta, reason, occurred_at
        FROM ${qualified("points_ledger")}
        WHERE member_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2 OFFSET $3
      `,
      [memberId, size, offset]
    );
    const totalResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total FROM ${qualified("points_ledger")} WHERE member_id = $1`,
      [memberId]
    );

    return {
      data: dataResult.rows.map((row) => ({
        ledgerId: row.ledger_id,
        delta: row.delta,
        reason: row.reason,
        occurredAt: row.occurred_at.toISOString(),
      })),
      page: toPageMeta(page, size, totalResult.rows[0].total),
    };
  }

  async function createPrivacyExport(memberId, payload) {
    const requestId = `PRIV-EXP-${Date.now()}`;
    await pool.query(
      `
        INSERT INTO ${qualified("privacy_requests")}
          (request_id, member_id, request_type, status, delivery_channel, language, expected_ready_at)
        VALUES ($1, $2, 'export', 'accepted', $3, $4, NOW() + INTERVAL '24 hour')
      `,
      [requestId, memberId, payload.deliveryChannel, payload.language || "zh-CN"]
    );
    return {
      requestId,
      status: "accepted",
      expectedReadyAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async function createPrivacyDelete(memberId) {
    const requestId = `PRIV-DEL-${Date.now()}`;
    await pool.query(
      `
        INSERT INTO ${qualified("privacy_requests")}
          (request_id, member_id, request_type, status)
        VALUES ($1, $2, 'delete', 'scheduled')
      `,
      [requestId, memberId]
    );
    return {
      requestId,
      status: "scheduled",
    };
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

  function mapProfile(row) {
    return {
      memberId: row.member_id,
      customerId: row.customer_id,
      nickname: row.nickname,
      phoneMasked: row.phone_masked,
      tier: row.tier,
      pointsBalance: row.points_balance,
      preferredStoreId: row.preferred_store_id,
      preferenceTags: row.preference_tags,
      joinedAt: row.joined_at.toISOString(),
    };
  }

  return {
    init,
    isReady,
    getProfile,
    updatePreferences,
    listBenefits,
    redeemBenefit,
    listPointsLedger,
    createPrivacyExport,
    createPrivacyDelete,
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

  const repository = createRepository(pool, process.env.DB_SCHEMA || "member");
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

  router.get("/members/:memberId", async (req, res, next) => {
    try {
      const profile = await repository.getProfile(req.params.memberId);
      if (!profile) {
        throw new AppError(404, "NOT_FOUND", "Member profile was not found.");
      }
      res.json(profile);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/members/:memberId/preferences", async (req, res, next) => {
    try {
      requireFields(req.body, ["preferenceTags"]);
      const profile = await repository.updatePreferences(req.params.memberId, req.body);
      if (!profile) {
        throw new AppError(404, "NOT_FOUND", "Member profile was not found.");
      }
      await repository.recordOutboxEvent(req.params.memberId, "member.preferences.updated", {
        traceId: req.traceId,
        memberId: req.params.memberId,
        preferenceTags: req.body.preferenceTags,
      });
      res.json(profile);
    } catch (error) {
      next(error);
    }
  });

  router.get("/members/:memberId/benefits", async (req, res, next) => {
    try {
      const benefits = await repository.listBenefits(req.params.memberId);
      res.json({ data: benefits });
    } catch (error) {
      next(error);
    }
  });

  router.post("/members/:memberId/benefits/redeem", async (req, res, next) => {
    try {
      requireFields(req.body, ["benefitId", "reservationId", "redeemedBy"]);
      const result = await repository.redeemBenefit(req.params.memberId, req.body);
      await repository.recordOutboxEvent(req.params.memberId, "member.benefit.redeemed", {
        traceId: req.traceId,
        memberId: req.params.memberId,
        benefitId: req.body.benefitId,
        reservationId: req.body.reservationId,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/members/:memberId/points-ledger", async (req, res, next) => {
    try {
      const page = Number.parseInt(req.query.page || "1", 10);
      const size = Number.parseInt(req.query.size || "20", 10);
      const result = await repository.listPointsLedger(req.params.memberId, page, size);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/members/:memberId/privacy/export", async (req, res, next) => {
    try {
      requireFields(req.body, ["deliveryChannel"]);
      const result = await repository.createPrivacyExport(req.params.memberId, req.body);
      await repository.recordOutboxEvent(req.params.memberId, "member.privacy.export.requested", {
        traceId: req.traceId,
        memberId: req.params.memberId,
        deliveryChannel: req.body.deliveryChannel,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/members/:memberId/privacy", async (req, res, next) => {
    try {
      const result = await repository.createPrivacyDelete(req.params.memberId);
      await repository.recordOutboxEvent(req.params.memberId, "member.privacy.delete.requested", {
        traceId: req.traceId,
        memberId: req.params.memberId,
      });
      res.status(202).json(result);
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
    logger.info({ port: PORT }, "member service listening");
  });

  async function shutdown(signal) {
    logger.info({ signal }, "shutting down member service");
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
