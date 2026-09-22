// scripts/check.js
//
// Lightweight local sanity check — no network calls, no HubSpot token
// required. Run with `npm run check` after cloning or before deploying.
// It verifies the project is structurally sound: config files parse,
// server modules load without throwing, and it warns (never fails) about
// optional-but-recommended environment variables.

const path = require("path");
const fs = require("fs");

let failures = 0;
let warnings = 0;

function ok(label) {
  console.log("  ✓ " + label);
}
function fail(label, err) {
  failures++;
  console.log("  ✗ " + label);
  if (err) console.log("      " + (err.message || err));
}
function warn(label) {
  warnings++;
  console.log("  ! " + label);
}

console.log("Pipeline Pulse — project check\n");

// 1. package.json / vercel.json parse cleanly
console.log("Config files:");
["package.json", "vercel.json"].forEach(function (f) {
  try {
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
    ok(f + " is valid JSON");
  } catch (e) {
    fail(f + " failed to parse", e);
  }
});

// 2. vercel.json ships a CSP frame-ancestors header and no X-Frame-Options
try {
  const vercelJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8")
  );
  const allHeaders = (vercelJson.headers || []).reduce(function (acc, block) {
    return acc.concat(block.headers || []);
  }, []);
  const csp = allHeaders.find(function (h) { return h.key === "Content-Security-Policy"; });
  const xfo = allHeaders.find(function (h) { return h.key === "X-Frame-Options"; });
  if (csp && /frame-ancestors/.test(csp.value)) {
    ok("Content-Security-Policy with frame-ancestors is set");
  } else {
    fail("No Content-Security-Policy frame-ancestors directive found in vercel.json");
  }
  if (xfo) {
    fail("X-Frame-Options is set — this will BLOCK iframe embedding regardless of CSP; remove it");
  } else {
    ok("No X-Frame-Options header (correct — it would override the CSP allowance)");
  }
} catch (e) {
  fail("Could not inspect vercel.json headers", e);
}

// 3. Server modules load without throwing (require-time errors only —
//    this does not call HubSpot or KV, it just checks the code is sound).
console.log("\nServer modules:");
["../lib/hubspot.js", "../lib/kv.js", "../api/refresh.js"].forEach(function (rel) {
  try {
    require(rel);
    ok(rel.replace("../", "") + " loads cleanly");
  } catch (e) {
    fail(rel.replace("../", "") + " threw on load", e);
  }
});

// 4. Env var presence (warnings only — this script must work with none set)
console.log("\nEnvironment (informational — not required to pass this check):");
if (process.env.HUBSPOT_ACCESS_TOKEN) {
  ok("HUBSPOT_ACCESS_TOKEN is set");
} else {
  warn("HUBSPOT_ACCESS_TOKEN is not set locally (required on Vercel — set it in Project Settings)");
}
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  ok("KV_REST_API_URL / KV_REST_API_TOKEN are set (week-over-week history enabled)");
} else {
  warn("KV env vars not set — week-over-week deltas will be disabled until a Vercel KV store is connected (optional)");
}

console.log("\n" + failures + " failure(s), " + warnings + " warning(s).");
if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("Looks good.");
}
