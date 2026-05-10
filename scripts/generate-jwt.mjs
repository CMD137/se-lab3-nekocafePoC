import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return {};
  }

  return readFileSync(envPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => !line.trim().startsWith("#"))
    .reduce((accumulator, line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const env = loadDotEnv();
const secret = process.env.JWT_SECRET || env.JWT_SECRET;

if (!secret) {
  console.error("JWT secret was not found. Load .env or set JWT_SECRET first.");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const header = {
  alg: "HS256",
  typ: "JWT",
};
const payload = {
  sub: "MEM-220501208",
  customerId: "CUS-10086",
  role: "member",
  scope: ["reservation:write", "reservation:read", "member:write", "member:read"],
  iss: "nekocafe-dev",
  aud: "nekocafe-local",
  iat: now,
  exp: now + 12 * 60 * 60,
};

const encodedHeader = encodeJson(header);
const encodedPayload = encodeJson(payload);
const signature = createHmac("sha256", secret)
  .update(`${encodedHeader}.${encodedPayload}`)
  .digest("base64url");

process.stdout.write(`${encodedHeader}.${encodedPayload}.${signature}`);
