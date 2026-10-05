// Exports the OpenAPI contract and policy/decision fixtures from their TypeScript sources.
// Run: node --experimental-strip-types scripts/export-contracts.mjs
import fs from "node:fs";
import { openapi } from "../apps/web/src/lib/openapi.ts";
import { buildDefaultPolicies } from "../packages/policy-core/src/packs.ts";

fs.writeFileSync("docs/api/openapi.json", JSON.stringify(openapi, null, 2) + "\n");
fs.writeFileSync("fixtures/policies/northstar-default-pack.json", JSON.stringify(buildDefaultPolicies(new Date(Date.UTC(2026, 6, 1))), null, 2) + "\n");
console.log("wrote docs/api/openapi.json and fixtures/policies/northstar-default-pack.json");
