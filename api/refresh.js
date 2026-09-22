// api/refresh.js
//
// POST (or GET) /api/refresh — the only thing the browser ever calls.
// Runs entirely server-side: reads HUBSPOT_ACCESS_TOKEN from the Vercel
// environment, calls HubSpot's CRM APIs, aggregates the numbers, and
// returns plain JSON. The token itself is never part of the response and
// never touches client-side code — see lib/hubspot.js.

const { getDashboardData, HubSpotError } = require("../lib/hubspot");
const kv = require("../lib/kv");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { data, sectionErrors } = await getDashboardData();

    let wow = null;
    if (!sectionErrors.mix) {
      const metrics = {
        date: kv.todayStr(),
        openValue: data.openTotal.value,
        weightedValue: data.openTotal.weighted,
        stalledDeals: data.stalledTotal.deals
      };
      try {
        wow = await kv.computeWow(metrics);
        await kv.saveSnapshot(metrics);
      } catch (e) {
        // WoW is best-effort; never let it fail the whole refresh
        wow = null;
      }
    }

    return res.status(200).json({
      ok: true,
      asOf: new Date().toISOString(),
      data: data,
      wow: wow,
      sectionErrors: sectionErrors,
      wowConfigured: kv.isConfigured()
    });
  } catch (err) {
    const status = err instanceof HubSpotError ? (err.status || 502) : 500;
    return res.status(status).json({
      ok: false,
      error: (err && err.message) || "Unexpected error talking to HubSpot"
    });
  }
};
