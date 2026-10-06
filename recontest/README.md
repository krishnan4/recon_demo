# ReconTest on Netlify — shared reports + server-side Auto Generate

The page (`public/index.html`) is still plain HTML, CSS and JavaScript. What changed is where the
report **list** lives. It used to be in each browser's localStorage. Now it is on Netlify:

| Part | File | What it does |
|---|---|---|
| Page | `public/index.html` | Login, forms, tables, Excel/CSV/zip downloads (built in the browser, same as before) |
| API | `netlify/functions/api.mjs` | `/api/login`, `/api/state`, `/api/reports`, `/api/reports/:id/retry`, `/api/auto`, `/api/reset` |
| Auto Generate | `netlify/functions/auto-generate.mjs` | Runs **every minute** on Netlify; makes the next batch when it is due (every 2 min by default) |
| Shared logic | `netlify/lib/recon-core.mjs` | Users, validation, report scheduling; stores everything in **Netlify Blobs** (store `recontest`, key `db`) |

Because of this:

- Any browser or laptop that logs in sees **the same reports**.
- Auto Generate runs on the server, so it **keeps going even when every browser is closed**.
- Open pages fetch new reports every 10 seconds while the tab is visible. The footer shows the last sync time.

## Deploy (Netlify CLI) — recommended

Drag-and-drop deploys **cannot** run Functions, so use the CLI (or Git, below).

```bash
# once: install Node.js 18+ from nodejs.org, then
npm install -g netlify-cli
netlify login

# in this folder
npm install
netlify link          # choose your existing site: recondemo
netlify deploy --prod
```

Open https://recondemo.netlify.app, log in (`melon12` / `Firstmelon@123`), go to
**Reports → Report Download**, and tick **Generate reports automatically**.

## Deploy (Git) — alternative

Push this folder to a GitHub repo. In Netlify open the **recondemo** site, then go to
**Site configuration → Build & deploy → Link repository** and pick the repo.
`netlify.toml` already sets publish folder `public` and the functions folder.
Every push then deploys automatically.

## Check that Auto Generate is running

Netlify dashboard → your site → **Logs → Functions → auto-generate**. You should see a run every minute,
and a line `Auto generate: N report(s) queued` every 2 minutes while Auto Generate is on.
Scheduled functions run on **production** deploys only (not deploy previews).

## Settings you may want to change

- **Users / passwords**: `USERS` at the top of `netlify/lib/recon-core.mjs`. Also update the hint on the login page in `public/index.html` if you change `melon12`.
- **Login token secret**: set an environment variable `RECON_SECRET` (any long random text) in
  Netlify → Site configuration → Environment variables, then redeploy.
- **Keep at most N reports**: `MAX_KEEP` in `recon-core.mjs` (default 3000; oldest are removed).
- **Polling**: `POLL_MS` in `public/index.html` (default 10 seconds).

## Free plan usage

On Netlify's credit-based free plan each production deploy and each function run uses credits.
This setup is small: one scheduled run per minute plus a light check from each open tab every 10 seconds.
Only changed reports are sent, not the whole list. Keep an eye on **Usage** in the Netlify dashboard if many people keep the portal open all day.
To reduce it, raise `POLL_MS`, or change the schedule in `auto-generate.mjs` to `"*/2 * * * *"` if you only ever use 2-minute intervals.

## Browser console helpers (for automation scripts)

```js
ReconTest.autoStart({ minutes: 2, reportName: "ALL", networkType: "CARD" })
ReconTest.autoStop()
ReconTest.autoStatus()
ReconTest.sync()      // fetch the latest list now
ReconTest.reset()     // admin only: back to the sample data
```
