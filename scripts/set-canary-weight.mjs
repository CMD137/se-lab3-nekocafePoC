import fs from "node:fs";
import path from "node:path";

const stableWeight = Number.parseInt(process.argv[2] || "95", 10);
const canaryWeight = Number.parseInt(process.argv[3] || "5", 10);

if (
  Number.isNaN(stableWeight) ||
  Number.isNaN(canaryWeight) ||
  stableWeight < 0 ||
  canaryWeight < 0 ||
  stableWeight + canaryWeight !== 100
) {
  console.error("Usage: node scripts/set-canary-weight.mjs <stableWeight> <canaryWeight>  # weights must sum to 100");
  process.exit(1);
}

const target = path.resolve("infra/cd/traefik/dynamic/reservation-weighted.yml");
const content = `http:
  services:
    reservation-rollout:
      weighted:
        services:
          - name: reservation-stable
            weight: ${stableWeight}
          - name: reservation-canary
            weight: ${canaryWeight}

    reservation-stable:
      loadBalancer:
        servers:
          - url: "http://reservation-stable:8080"

    reservation-canary:
      loadBalancer:
        servers:
          - url: "http://reservation-canary:8080"
`;

fs.writeFileSync(target, content, "utf8");
console.log(`updated canary weights: stable=${stableWeight}, canary=${canaryWeight}`);
