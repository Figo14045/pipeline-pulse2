// lib/kv.js
//
// Week-over-week history, ported from the artifact's `db` capability to a
// Vercel KV (Upstash Redis) store. Entirely optional: if KV_REST_API_URL /
// KV_REST_API_TOKEN aren't set (no KV database connected to the project),
// every function here is a no-op and the dashboard simply shows "no
// history yet" forever, same as it would with KV configured but empty.

function isConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// Lazy require so a project with no KV connected never even loads the
// package's env-reading code path.
function client() {
  var mod = require("@vercel/kv");
  return mod.kv;
}

function todayStr(d) {
  d = d || new Date();
  return d.toISOString().slice(0, 10);
}

/** Save today's point-in-time metrics. Best-effort: a failure here should
 *  never take down the refresh endpoint, it just delays WoW by a day. */
async function saveSnapshot(metrics) {
  if (!isConfigured()) return;
  try {
    var kv = client();
    var date = todayStr();
    await kv.set("snapshot:" + date, metrics);
    await kv.zadd("snapshot:index", { score: Date.parse(date), member: date });
  } catch (e) {
    // swallow — WoW is a nice-to-have, not a reason to fail a refresh
  }
}

/** Closest snapshot to ~7 days ago (5-9 day window), or null if none exists
 *  yet / KV isn't configured / anything goes wrong reading it. */
async function getWeekAgoSnapshot() {
  if (!isConfigured()) return null;
  try {
    var kv = client();
    var today = new Date();
    var members = await kv.zrange("snapshot:index", 0, -1); // small set; fine to scan
    if (!members || !members.length) return null;
    var target = 7, best = null, bestDist = Infinity;
    members.forEach(function (date) {
      var days = Math.round((today - new Date(date)) / 86400000);
      var dist = Math.abs(days - target);
      if (days >= 5 && days <= 9 && dist < bestDist) { best = date; bestDist = dist; }
    });
    if (!best) return null;
    var snap = await kv.get("snapshot:" + best);
    return snap || null;
  } catch (e) {
    return null;
  }
}

/** { openValue, weightedValue, stalledDeals } deltas vs. ~a week ago, or
 *  null when there's nothing to compare against. */
async function computeWow(current) {
  var prev = await getWeekAgoSnapshot();
  if (!prev) return null;
  return {
    openValue: current.openValue - prev.openValue,
    weightedValue: current.weightedValue - prev.weightedValue,
    stalledDeals: current.stalledDeals - prev.stalledDeals,
    comparedTo: prev.date || null
  };
}

module.exports = {
  isConfigured: isConfigured,
  saveSnapshot: saveSnapshot,
  computeWow: computeWow,
  todayStr: todayStr
};
