# ReconTest on Vercel — shared reports + server-side Auto Generate

The page (`public/index.html`) is still plain HTML, CSS and JavaScript. The report **list** now lives on
the server instead of in each browser's localStorage, so:

- any browser or laptop that logs in sees **the same reports**, and they are still there after logout/login;
- the **Auto Generate** setting is shared, and batches are made on the server, **once each**, even if many pages are open.
- **Auto Generate is ON from the start**: every 2 minutes, all 8 reports, today's date, CARD network. Nobody has to tick anything.
  (To change what it makes, pick other values in the Report Download form while it is on. You can still switch it off there.)

| Part | File | What it does |
|---|---|---|
| Page | `public/index.html` | Login, forms, tables, Excel/CSV/zip downloads (built in the browser, as before) |
| API | `api/*.js` → `lib/redis-api.mjs` | `/api/login`, `/api/state`, `/api/reports`, `/api/retry`, `/api/auto`, `/api/tick`, `/api/reset` |
| Rules | `lib/recon-core.mjs` | Users, validation, report scheduling, auto generate |
| Storage | Upstash Redis (free) | Connected through Vercel → Storage |

## 1. Connect free storage (one time)

1. Vercel dashboard → your project (**recondemo-8hki**) → **Storage** tab.
2. **Create Database** / **Browse Marketplace** → **Upstash** → **Redis** → choose the **Free** plan.
3. **Connect** it to this project (tick Production, Preview, Development).
   Vercel adds the keys automatically (`KV_REST_API_URL` / `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — both work).

## 2. Put these files in the project and deploy

Keep the folder layout exactly: `api/`, `lib/`, `public/`, `package.json`, `vercel.json` at the top level.

**If the project is linked to GitHub:** replace the repo's files with these, commit and push. Vercel deploys by itself.

**If you deploy with the CLI:**

```bash
npm install -g vercel
vercel login
cd recontest-vercel
vercel link        # choose recondemo-8hki
vercel --prod
```

In **Settings → Build and Deployment** keep Framework Preset = **Other** and leave the build command empty.
`vercel.json` already tells Vercel to serve the `public` folder.

## 3. Check it worked

- Open `https://recondemo-8hki.vercel.app/api/state` → you should see `{"error":"Please log in again"}`.
  A 404 page means the `api` folder was not deployed.
- Log in → the footer shows **"Shared data · synced HH:MM:SS"**.
- If you see *"Storage is not connected…"*, do step 1 and redeploy.
- Generate a report, log out, log in from another browser or incognito → the report is there.

## 4. Auto Generate every 2 minutes, even with all browsers closed (free)

Vercel's own cron on the free (Hobby) plan can only run **once a day**, so use a free outside scheduler:

1. In Vercel → **Settings → Environment Variables** add `CRON_SECRET` = any long random text. Redeploy.
2. Sign up at **cron-job.org** (free) → **Create cronjob**:
   - URL: `https://recondemo-8hki.vercel.app/api/tick?key=YOUR_CRON_SECRET`
   - Schedule: **every 1 minute**
3. Save. The server makes a batch only when one is due, so calling it every minute is safe.

Without step 4, Auto Generate still runs whenever the portal is open in **any** browser on **any** laptop:
the open page tells the server when a batch is due.

## Settings you may want to change

- **Users / passwords**: `USERS` at the top of `lib/recon-core.mjs`. Also update the hint on the login page in `public/index.html` if you change `melon12`.
- **Login token secret**: add environment variable `RECON_SECRET` (any long random text) and redeploy. Do this if the repo is public.
- **Keep at most N reports**: `MAX_KEEP` in `lib/recon-core.mjs` (default 3000; the oldest are removed).
- **Polling**: `POLL_MS` in `public/index.html` (default 10 seconds).

## Free plan usage

Upstash free: 500K commands a month. Rough usage:

- each open, visible tab: about 1 command every 10 seconds;
- each auto batch: about 3 commands;
- the cron: 1 command a minute (~43K a month).

That is fine for a few people. Watch **Usage** in the Upstash console if many tabs stay open all day.
To use less, raise `POLL_MS`.

## Browser console helpers (for automation scripts)

```js
ReconTest.autoStart({ minutes: 2, reportName: "ALL", networkType: "CARD" })
ReconTest.autoStop()
ReconTest.autoStatus()
ReconTest.sync()      // fetch the latest list now
ReconTest.reset()     // admin only: back to the sample data
```
