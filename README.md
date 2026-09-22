# Pipeline Pulse

A live HubSpot sales-pipeline dashboard: open pipeline value, weighted forecast,
stalled deals, pipeline mix, stage funnel, rep leaderboard, and a 12-month
won/lost trend, with an optional week-over-week comparison. This is a
standalone version of the original Pipeline Pulse Claude Artifact, rebuilt to
run on your own Vercel deployment instead of inside Claude.

## How it's put together

```
pipeline-pulse-app/
  api/
    refresh.js       Serverless function — the ONLY thing the browser calls.
  lib/
    hubspot.js        Server-side HubSpot client + aggregation. Never sent to the browser.
    kv.js              Optional week-over-week snapshot store (Vercel KV).
  public/
    index.html         The dashboard page (HTML/CSS/JS, no build step, no framework).
  scripts/
    check.js           Local sanity check (npm run check) — no network calls.
  vercel.json          Iframe/CSP headers + routing.
  package.json
  .env.example
```

There is no build step and no frontend framework — `public/index.html` is
served as a static file, and `api/refresh.js` runs as a Vercel Node.js
Serverless Function. The browser never talks to HubSpot directly; it only
ever calls `POST /api/refresh` on your own deployment, and that function
holds the HubSpot token server-side.

### Where each requirement is satisfied

| # | Requirement | Where |
|---|---|---|
| 1 | Deployable to Vercel | `vercel.json`, framework-less static + Serverless Functions |
| 2 | No Claude Artifact-specific auth | `public/index.html` has no `window.claude.*` calls at all |
| 3 | HubSpot calls server-side | `lib/hubspot.js`, only ever imported by `api/refresh.js` |
| 4 | Token never in browser JS | Token is read from `process.env` inside `lib/hubspot.js`; nothing in `public/` references it |
| 5 | API endpoint pulls latest HubSpot data | `api/refresh.js` |
| 6 | "Refresh from HubSpot" button calls it | `public/index.html` → `fetch("/api/refresh", { method: "POST" })` |
| 7 | Safe inside a HubSpot dashboard iframe | No `X-Frame-Options` anywhere; CSP allows framing instead |
| 8 | CSP `frame-ancestors` for HubSpot | `vercel.json` → `Content-Security-Policy: frame-ancestors ...` |
| 9 | Secrets as environment variables | `HUBSPOT_ACCESS_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` — never committed |
| 10 | Deployment instructions + URL structure | This file |

## 1. Create a HubSpot Private App (read-only token)

1. In HubSpot: **Settings → Integrations → Private Apps → Create a private app**.
2. Give it a name, e.g. "Pipeline Pulse (read-only)".
3. Under **Scopes**, add these read scopes:
   - `crm.objects.deals.read`
   - `crm.objects.owners.read`
   - `crm.schemas.deals.read`
4. Create the app and copy the **access token** it gives you (starts with `pat-...`).
   Treat it like a password — it's the only credential this app needs, and it's read-only.

You do not need any write scopes; the dashboard never modifies HubSpot data.

## 2. Deploy to Vercel

### Option A — Vercel CLI

```bash
cd pipeline-pulse-app
npm install
npx vercel        # first deploy — follow the prompts to link/create a project
npx vercel --prod  # promote to production
```

### Option B — Vercel dashboard

1. Push this folder to a GitHub/GitLab/Bitbucket repo (or upload it directly).
2. In Vercel: **Add New → Project**, import the repo.
3. Framework preset: **Other** (no build command needed — leave build command
   and output directory blank; Vercel will serve `public/` and `api/` automatically).
4. Deploy.

Either way, Vercel detects `api/*.js` as Serverless Functions and serves
everything in `public/` as static files — no extra configuration needed
beyond `vercel.json`, which is already in this project.

## 3. Set environment variables

In the Vercel dashboard: **Project → Settings → Environment Variables**.

| Variable | Required | Notes |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Yes | The Private App token from step 1. Set for Production (and Preview, if you use preview deployments). |
| `KV_REST_API_URL` | No | Auto-filled if you connect a Vercel KV store (step 4). Leave unset to disable week-over-week deltas. |
| `KV_REST_API_TOKEN` | No | Same as above. |

Redeploy after adding/changing environment variables (Vercel prompts you to,
or run `npx vercel --prod` again).

See `.env.example` for the same list with inline comments — copy it to
`.env.local` for local development only; never commit a real token.

## 4. (Optional) Enable week-over-week comparisons

The dashboard can show "vs. last week" deltas for open value, weighted value,
and stalled deals. This needs a small key-value store to remember daily
snapshots — it's optional, and the dashboard works fine without it (the
comparison line just says "not enough history yet").

1. In Vercel: **Storage → Create Database → KV** (Upstash Redis under the hood).
2. Connect it to this project. Vercel automatically injects `KV_REST_API_URL`
   and `KV_REST_API_TOKEN` — you don't set these by hand.
3. Redeploy. Snapshots are taken automatically each time `/api/refresh` runs
   with a successful pull, so the comparison fills in once there's a
   snapshot from ~5–9 days earlier.

## 5. Final URL structure

Once deployed, Vercel gives you a production URL like
`https://pipeline-pulse.vercel.app` (or a custom domain you attach). On that
domain:

- **`https://pipeline-pulse.vercel.app/`** — the dashboard page itself. This
  is the URL you embed in a HubSpot dashboard iframe or open directly.
- **`https://pipeline-pulse.vercel.app/api/refresh`** — the serverless API
  endpoint. The page's "Refresh from HubSpot" button calls this with `POST`;
  it also fires once automatically on page load. It's a plain JSON endpoint
  (`{ ok, asOf, data, wow, sectionErrors, wowConfigured }`) — you can call it
  yourself for testing (`curl -X POST https://.../api/refresh`), but there's
  nothing else in the app for it to feed except the dashboard page.

Every deployment (including preview deployments from a git branch) gets its
own URL following the same `<project>.vercel.app/` and
`<project>.vercel.app/api/refresh` pattern.

## 6. Embedding inside a HubSpot dashboard iframe

`vercel.json` sends:

```
Content-Security-Policy: frame-ancestors 'self' https://*.hubspot.com https://*.hubspotqa.com;
```

on every response, and deliberately never sends `X-Frame-Options` (which
would block framing outright regardless of CSP — older HubSpot embedding
guides sometimes mention it, but it must **not** be added here).

If HubSpot embeds dashboards from a different domain in your account/region
(for example a dedicated CDN or a non-`.hubspot.com` domain), add it to the
`frame-ancestors` value in `vercel.json` and redeploy — this is a static
header, not read from an environment variable, so a code change + redeploy
is required to change the allowlist. You can widen it temporarily to `*`
while testing embedding, but narrow it back down before sharing broadly.

## 7. Security notes — please read before sharing this URL

- **No page-level login is included.** Anyone who has the URL can view the
  dashboard (it only ever reads HubSpot data server-side; a viewer can't get
  the token or write anything back, but they can see the numbers). This was
  a deliberate choice, not an oversight: the most common way to add auth
  (HTTP Basic Auth, or a login cookie) tends to break when the page is
  loaded inside a third-party iframe, because browsers increasingly restrict
  credentials and cookies in cross-site iframes — exactly the HubSpot
  embedding scenario requirement #7 asks for. Adding real auth and iframe
  embedding at the same time needs a bit more design (e.g. a signed,
  short-lived token passed in the iframe URL, or restricting access at the
  network/Vercel level) — happy to add that as a follow-up if you want the
  URL locked down beyond "only people with the link."
- In the meantime, treat the deployment URL the way you'd treat an
  unlisted-but-not-secret link: don't post it somewhere public, and rely on
  it being embedded inside HubSpot (which is itself behind your team's
  HubSpot login) as the main access boundary.
- The HubSpot token is read-only and never leaves the server — confirmed by
  the fact that `public/index.html` contains no reference to it at all
  (see the requirements table above).

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in HUBSPOT_ACCESS_TOKEN
npm run check                 # structural sanity check, no network calls
npx vercel dev                 # runs the static page + serverless functions locally
```

## Troubleshooting

- **Dashboard loads but shows an error banner instead of data**: almost
  always `HUBSPOT_ACCESS_TOKEN` is missing, wrong, or missing a scope. Check
  Vercel → Project → Settings → Environment Variables, and check the token's
  scopes in HubSpot.
- **Page won't load inside the HubSpot dashboard iframe**: check the browser
  console on the HubSpot page for a CSP violation; confirm the embedding
  domain matches an entry in `frame-ancestors` in `vercel.json`.
- **Week-over-week always says "not enough history yet"**: expected until a
  KV store has been collecting snapshots for about a week; confirm
  `KV_REST_API_URL` / `KV_REST_API_TOKEN` are set if you expected it sooner.
