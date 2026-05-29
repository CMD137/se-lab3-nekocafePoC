import { createDevToken, loadDotEnv } from "./generate-jwt.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return data;
}

async function main() {
  const env = loadDotEnv();
  const secret = process.env.JWT_SECRET || env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT secret was not found. Load .env or set JWT_SECRET first.");
  }

  const token = createDevToken(secret);
  const headers = {
    Authorization: `Bearer ${token}`,
  };

  const reservationHealth = await fetchJson("http://localhost:8081/healthz");
  assert(reservationHealth.status === "ok", "Reservation health check failed.");

  const memberHealth = await fetchJson("http://localhost:8082/healthz");
  assert(memberHealth.status === "ok", "Member health check failed.");

  const availability = await fetchJson(
    "http://localhost:8081/reservation/v1/availability?storeId=STORE-BJ-001&date=2026-05-10&partySize=4",
    { headers }
  );
  assert(Array.isArray(availability.slots) && availability.slots.length > 0, "Availability payload is empty.");

  const memberProfile = await fetchJson("http://localhost:8082/member/v1/members/MEM-220501208", { headers });
  assert(memberProfile.memberId === "MEM-220501208", "Member profile payload is invalid.");

  console.log("Smoke checks passed.");
  console.log(`reservation-health=${reservationHealth.status}`);
  console.log(`member-health=${memberHealth.status}`);
  console.log(`availability-slots=${availability.slots.length}`);
  console.log(`member-tier=${memberProfile.tier}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
