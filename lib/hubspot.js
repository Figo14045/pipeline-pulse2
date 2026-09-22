// lib/hubspot.js
//
// Server-side HubSpot client + the exact aggregation logic the dashboard
// used to get "for free" from HubSpot's internal query_crm_data tool when
// this ran as a Claude Artifact. Here it's ported to HubSpot's public CRM
// APIs, called with a Private App token from process.env — this file is
// never bundled into the browser, so the token never leaves the server.
//
// Nothing in this file reads a request object or a browser global; it's a
// plain Node module imported by api/refresh.js.

const HUBSPOT_BASE = "https://api.hubapi.com";

class HubSpotError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "HubSpotError";
    this.status = status;
    this.body = body;
  }
}

function getToken() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new HubSpotError(
      "HUBSPOT_ACCESS_TOKEN is not set. Add it in Vercel -> Settings -> Environment Variables.",
      500,
      null
    );
  }
  return token;
}

async function hsFetch(path, options) {
  const token = getToken();
  const res = await fetch(HUBSPOT_BASE + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options && options.headers ? options.headers : {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* leave null */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || res.statusText || "HubSpot request failed";
    throw new HubSpotError(msg, res.status, json);
  }
  return json;
}

/** Paginate the CRM Search API until exhausted. Safety-capped so a runaway
 *  loop can't hammer HubSpot or hang the function forever. */
async function searchAllDeals(body, opts) {
  opts = opts || {};
  const pageSize = opts.pageSize || 100;
  const maxPages = opts.maxPages || 100; // 100 x 100 = up to 10,000 deals
  var all = [];
  var after = undefined;
  for (var page = 0; page < maxPages; page++) {
    var reqBody = Object.assign({}, body, { limit: pageSize });
    if (after) reqBody.after = after;
    var res = await hsFetch("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify(reqBody)
    });
    var results = (res && res.results) || [];
    all = all.concat(results);
    after = res && res.paging && res.paging.next && res.paging.next.after;
    if (!after) break;
  }
  return all;
}

async function getPipelineMeta() {
  var res = await hsFetch("/crm/v3/pipelines/deals", { method: "GET" });
  var pipelines = (res && res.results) || [];
  var pipelineLabel = {};
  var stageLabel = {};
  var stageOrder = {};
  pipelines.forEach(function (p) {
    pipelineLabel[p.id] = p.label;
    (p.stages || []).forEach(function (s) {
      var key = p.id + "|" + s.id;
      stageLabel[key] = s.label;
      stageOrder[key] = typeof s.displayOrder === "number" ? s.displayOrder : 999;
    });
  });
  return { pipelineLabel: pipelineLabel, stageLabel: stageLabel, stageOrder: stageOrder };
}

async function getOwnerNameMap() {
  var map = {};
  var after = undefined;
  for (var page = 0; page < 20; page++) { // 20 x 100 = up to 2,000 owners
    var qs = "?limit=100" + (after ? "&after=" + encodeURIComponent(after) : "");
    var res = await hsFetch("/crm/v3/owners" + qs, { method: "GET" });
    var results = (res && res.results) || [];
    results.forEach(function (o) {
      var name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
      map[String(o.id)] = name || o.email || ("Owner " + o.id);
    });
    after = res && res.paging && res.paging.next && res.paging.next.after;
    if (!after) break;
  }
  return map;
}

function num(v) {
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function isTrue(v) {
  return v === true || v === "true";
}

/** First day of the month 12 months ago, and today — the same trailing
 *  window the dashboard has always used for the closed-won/lost trend. */
function trailing12MonthRange() {
  var end = new Date();
  var start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), 1));
  return { start: start, end: end };
}

function monthKey(epochMs) {
  var d = new Date(Number(epochMs));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * Runs the full live pull and returns the SAME shape the dashboard's
 * client-side `data` object has always used, plus a `sectionErrors` map so
 * the UI's existing per-panel degradation can still work.
 */
async function getDashboardData() {
  var sectionErrors = {}; // { mix, funnel, owners, trend } -> error message or undefined

  var pipelineMeta = null;
  try { pipelineMeta = await getPipelineMeta(); }
  catch (e) { sectionErrors.pipelineMeta = e.message; }

  var openDeals = [];
  try {
    openDeals = await searchAllDeals({
      filterGroups: [{ filters: [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }] }],
      properties: ["pipeline", "dealstage", "amount_in_home_currency", "hs_projected_amount_in_home_currency", "hs_is_stalled", "hubspot_owner_id"]
    });
  } catch (e) {
    sectionErrors.mix = e.message;
    sectionErrors.funnel = e.message;
    sectionErrors.owners = e.message;
  }

  var range = trailing12MonthRange();
  var closedDeals = [];
  try {
    closedDeals = await searchAllDeals({
      filterGroups: [
        { filters: [
          { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
          { propertyName: "closedate", operator: "GTE", value: String(range.start.getTime()) },
          { propertyName: "closedate", operator: "LTE", value: String(range.end.getTime()) }
        ] },
        { filters: [
          { propertyName: "hs_is_closed_lost", operator: "EQ", value: "true" },
          { propertyName: "closedate", operator: "GTE", value: String(range.start.getTime()) },
          { propertyName: "closedate", operator: "LTE", value: String(range.end.getTime()) }
        ] }
      ],
      properties: ["amount_in_home_currency", "closedate", "hs_is_closed_won", "hs_is_closed_lost"]
    });
  } catch (e) {
    sectionErrors.trend = e.message;
  }

  // ---- pipeline mix + stage funnel + stalled + owner aggregation ----
  var pipelineAgg = {}; // pid -> {deals, value, weighted}
  var stageAgg = {};    // pid|stageid -> {deals, value}
  var ownerAgg = {};    // ownerId -> {deals, value}
  var stalledDeals = 0;

  openDeals.forEach(function (d) {
    var p = d.properties || {};
    var pid = p.pipeline || "unknown";
    var val = num(p.amount_in_home_currency);
    var wt = num(p.hs_projected_amount_in_home_currency);

    if (!pipelineAgg[pid]) pipelineAgg[pid] = { deals: 0, value: 0, weighted: 0 };
    pipelineAgg[pid].deals++; pipelineAgg[pid].value += val; pipelineAgg[pid].weighted += wt;

    var sk = pid + "|" + (p.dealstage || "unknown");
    if (!stageAgg[sk]) stageAgg[sk] = { deals: 0, value: 0 };
    stageAgg[sk].deals++; stageAgg[sk].value += val;

    if (isTrue(p.hs_is_stalled)) stalledDeals++;

    if (p.hubspot_owner_id) {
      var oid = String(p.hubspot_owner_id);
      if (!ownerAgg[oid]) ownerAgg[oid] = { deals: 0, value: 0 };
      ownerAgg[oid].deals++; ownerAgg[oid].value += val;
    }
  });

  var pipelineIds = Object.keys(pipelineAgg).sort(function (a, b) { return pipelineAgg[b].value - pipelineAgg[a].value; });
  var pipelineMix = pipelineIds.map(function (pid, i) {
    var label = (pipelineMeta && pipelineMeta.pipelineLabel[pid]) || ("Pipeline " + pid);
    return { name: label, deals: pipelineAgg[pid].deals, value: pipelineAgg[pid].value, emphasis: i === 0 };
  });
  var openTotal = pipelineIds.reduce(function (acc, pid) {
    acc.deals += pipelineAgg[pid].deals; acc.value += pipelineAgg[pid].value; acc.weighted += pipelineAgg[pid].weighted;
    return acc;
  }, { deals: 0, value: 0, weighted: 0 });

  var activePipelineId = pipelineIds[0];
  var fsFunnel = Object.keys(stageAgg)
    .filter(function (sk) { return sk.split("|")[0] === activePipelineId && stageAgg[sk].deals > 0; })
    .map(function (sk) {
      var stageId = sk.split("|")[1];
      var label = (pipelineMeta && pipelineMeta.stageLabel[sk]) || ("Stage " + stageId);
      var order = (pipelineMeta && pipelineMeta.stageOrder[sk]);
      return { stage: label, deals: stageAgg[sk].deals, value: stageAgg[sk].value, _order: typeof order === "number" ? order : 999 };
    })
    .sort(function (a, b) { return a._order - b._order; })
    .map(function (r) { return { stage: r.stage, deals: r.deals, value: r.value }; });

  var ownerIds = Object.keys(ownerAgg).sort(function (a, b) { return ownerAgg[b].value - ownerAgg[a].value; });
  var ownerNameMap = {};
  if (ownerIds.length) {
    try { ownerNameMap = await getOwnerNameMap(); }
    catch (e) { /* non-fatal: falls back to "Owner <id>" below */ }
  }
  var topOwnerIds = ownerIds.slice(0, 10);
  var restOwnerIds = ownerIds.slice(10);
  var owners = topOwnerIds.map(function (oid) {
    return { name: ownerNameMap[oid] || ("Owner " + oid), deals: ownerAgg[oid].deals, value: ownerAgg[oid].value };
  });
  var ownersRemainder = restOwnerIds.reduce(function (acc, oid) {
    acc.count++; acc.deals += ownerAgg[oid].deals; acc.value += ownerAgg[oid].value;
    return acc;
  }, { count: 0, deals: 0, value: 0 });

  // ---- monthly won/lost trend ----
  var wonByMonth = {}, lostByMonth = {};
  closedDeals.forEach(function (d) {
    var p = d.properties || {};
    if (!p.closedate) return;
    var mk = monthKey(p.closedate);
    var val = num(p.amount_in_home_currency);
    if (isTrue(p.hs_is_closed_won)) {
      if (!wonByMonth[mk]) wonByMonth[mk] = { count: 0, value: 0 };
      wonByMonth[mk].count++; wonByMonth[mk].value += val;
    } else if (isTrue(p.hs_is_closed_lost)) {
      if (!lostByMonth[mk]) lostByMonth[mk] = { count: 0, value: 0 };
      lostByMonth[mk].count++; lostByMonth[mk].value += val;
    }
  });
  var months = Array.from(new Set(Object.keys(wonByMonth).concat(Object.keys(lostByMonth)))).sort();
  var trend = {
    months: months,
    won: months.map(function (m) { return wonByMonth[m] ? wonByMonth[m].value : 0; }),
    wonCount: months.map(function (m) { return wonByMonth[m] ? wonByMonth[m].count : 0; }),
    lost: months.map(function (m) { return lostByMonth[m] ? lostByMonth[m].value : 0; }),
    lostCount: months.map(function (m) { return lostByMonth[m] ? lostByMonth[m].count : 0; })
  };

  return {
    data: {
      openTotal: openTotal,
      stalledTotal: { deals: stalledDeals, ofOpen: openTotal.deals },
      pipelineMix: pipelineMix,
      fsFunnel: fsFunnel,
      owners: owners,
      ownersRemainder: ownersRemainder,
      trend: trend
    },
    sectionErrors: sectionErrors
  };
}

module.exports = { getDashboardData: getDashboardData, HubSpotError: HubSpotError };
