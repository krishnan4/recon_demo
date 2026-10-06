/* ReconTest API on Vercel, with the report list in Redis (Upstash, free plan).
   Business rules (users, validation, scheduling, auto generate) come from recon-core.mjs.

   Redis keys
     recontest:meta     JSON  { epoch, nextId, slots, auto }
     recontest:ver      number, goes up by 1 on every change
     recontest:reports  hash  id -> report JSON
     recontest:revs     zset  id scored by the version that last changed it (for "what changed since v")
     recontest:ids      zset  id scored by id (to remove the oldest beyond MAX_KEEP)
   Every change is written by one Lua script that first checks the version, so two requests
   at the same moment (two laptops, two tabs, the cron) can never overwrite each other. */
import {
    HttpError, USERS, makeToken, readToken, initDb, createReports, retryReport, setAuto, runAuto, MAX_KEEP,
} from "./recon-core.mjs";

const K = ["recontest:meta", "recontest:ver", "recontest:reports", "recontest:revs", "recontest:ids"];
const [META, VER, REPORTS] = K;

// ARGV: 1 expected version ("" = must not exist yet), 2 meta JSON, 3 new version, 4 reset "1"/"0", 5 keep, then id, json pairs
const COMMIT = `
local ver = redis.call('GET', KEYS[2])
if ARGV[1] == '' then
  if ver then return 0 end
elseif ver ~= ARGV[1] then
  return 0
end
if ARGV[4] == '1' then redis.call('DEL', KEYS[3], KEYS[4], KEYS[5]) end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
for i = 6, #ARGV, 2 do
  redis.call('HSET', KEYS[3], ARGV[i], ARGV[i + 1])
  redis.call('ZADD', KEYS[4], ARGV[3], ARGV[i])
  redis.call('ZADD', KEYS[5], ARGV[i], ARGV[i])
end
local keep = tonumber(ARGV[5])
local count = redis.call('ZCARD', KEYS[5])
if count > keep then
  local old = redis.call('ZRANGE', KEYS[5], 0, count - keep - 1)
  for _, id in ipairs(old) do
    redis.call('HDEL', KEYS[3], id)
    redis.call('ZREM', KEYS[4], id)
    redis.call('ZREM', KEYS[5], id)
  end
end
return 1`;

const NOCHANGE = Symbol("nochange");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
// the Redis client may hand back JSON text or already-parsed objects; accept both
const val = (s) => (typeof s === "string" ? JSON.parse(s) : s);
const clampTz = (v) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= 840 ? Math.round(n) : 0; };

/**
 * getClient() returns { mget(...keys), eval(script, keys, args), hvals(key), hget(key, field),
 * idsAfter(zsetKey, score) -> ids with score > score, hmget(key, fields) -> values in the same order }.
 */
export function createRedisApi(getClient) {
    const r = () => getClient();

    async function readMeta() {
        const [m, v] = await r().mget(META, VER);
        if (!m || v == null) return null;
        return { ...val(m), version: Number(v) };
    }
    async function commit(db, expected, changed, reset) {
        const meta = { epoch: db.epoch, nextId: db.nextId, slots: db.slots, auto: db.auto };
        const args = [expected == null ? "" : String(expected), JSON.stringify(meta), String(db.version), reset ? "1" : "0", String(MAX_KEEP)];
        for (const rep of changed) args.push(String(rep.id), JSON.stringify(rep));
        return Number(await r().eval(COMMIT, K, args)) === 1;
    }
    /** read → change → write; tried again when someone else wrote in between */
    async function update(fn, { tz = 0, load = null, reset = false } = {}) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const meta = await readMeta();
            const fresh = !meta;
            const db = fresh ? initDb(Date.now(), tz) : { ...meta, reports: load ? await load() : [] };
            const expected = fresh ? null : meta.version;
            const result = fn(db);
            if (result === NOCHANGE && !fresh) return { db, changed: [], result: null };
            db.version = (fresh ? 0 : expected) + 1;
            const all = fresh || reset;
            const changed = all ? db.reports : db.reports.filter((x) => x.rev === db.version);
            if (await commit(db, expected, changed, all && !fresh)) return { db, changed, result: result === NOCHANGE ? null : result };
            await sleep(40 * 2 ** attempt + Math.random() * 60);
        }
        throw new HttpError(503, "The server is busy - please try again");
    }

    async function fullReports() {
        const vals = await r().hvals(REPORTS);
        return (vals || []).map(val).sort((a, b) => a.id - b.id);
    }
    /** what the browser needs, given what it already has (epoch + version) */
    async function stateFor(meta, epoch, v, justChanged = null) {
        const base = { epoch: meta.epoch, version: meta.version, maxKeep: MAX_KEEP, auto: meta.auto };
        if (epoch !== meta.epoch || !Number.isFinite(v) || v > meta.version) return { ...base, full: true, reports: await fullReports() };
        if (v === meta.version) return { ...base, full: false, reports: [] };
        if (justChanged && v === meta.version - 1) return { ...base, full: false, reports: justChanged };
        const ids = (await r().idsAfter(K[3], v)) || [];
        const vals = ids.length ? await r().hmget(REPORTS, ids.map(String)) : [];
        return { ...base, full: false, reports: vals.filter((x) => x != null).map(val).sort((a, b) => a.id - b.id) };
    }
    const metaOf = (db) => ({ epoch: db.epoch, version: db.version, auto: db.auto });

    async function tick() {
        const meta = await readMeta();
        if (!meta || !meta.auto || !meta.auto.on || Date.now() < meta.auto.next - 20000) return { ran: false, made: 0, meta };
        const out = await update((d) => runAuto(d, Date.now()) || NOCHANGE);
        return { ran: !!out.result, made: out.result ? out.result.length : 0, out };
    }

    async function handle(req) {
        try {
            const url = new URL(req.url);
            const path = url.pathname.replace(/^\/api/, "").replace(/\.(m?js)$/, "").replace(/\/+$/, "") || "/";
            const tz = clampTz(req.headers.get("x-tz-offset"));
            const epoch = url.searchParams.get("epoch") || "", v = Number(url.searchParams.get("v") ?? NaN);
            const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
            const now = Date.now();

            if (path === "/login" && req.method === "POST") {
                const u = String(body.username || "").trim(), user = USERS[u];
                if (!user || user.password !== String(body.password || "")) return json({ error: "Invalid username or password." }, 401);
                return json({ token: makeToken(u), user: { username: u, name: user.name, role: user.role }, now });
            }

            const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
            const user = readToken(bearer);

            // the scheduler (cron-job.org, Vercel Cron, or an open portal page) asks: is an auto batch due?
            if (path === "/tick") {
                const secret = process.env.CRON_SECRET;
                const cronOk = !secret || bearer === secret || url.searchParams.get("key") === secret;
                if (!user && !cronOk) return json({ error: "Wrong or missing key" }, 401);
                const t = await tick();
                const res = { now, ran: t.ran, made: t.made };
                if (user) {
                    const meta = t.out ? metaOf(t.out.db) : t.meta;
                    if (meta) res.state = await stateFor(meta, epoch, v, t.out ? t.out.changed : null);
                }
                return json(res);
            }

            if (!user) return json({ error: "Please log in again" }, 401);

            if (path === "/state" && req.method === "GET") {
                let meta = await readMeta();
                if (!meta) meta = metaOf((await update(() => undefined, { tz })).db);
                return json({ now, state: await stateFor(meta, epoch, v) });
            }
            if (path === "/reports" && req.method === "POST") {
                const { db, changed, result } = await update((d) => createReports(d, body, user.username, now, tz), { tz });
                return json({ now, made: result.map((x) => x.id), state: await stateFor(metaOf(db), epoch, v, changed) });
            }
            if (path === "/retry" && req.method === "POST") {
                const id = Number(url.searchParams.get("id"));
                const load = async () => { const s = await r().hget(REPORTS, String(id)); return s ? [val(s)] : []; };
                const { db, changed } = await update((d) => retryReport(d, id, user.username, now), { tz, load });
                return json({ now, state: await stateFor(metaOf(db), epoch, v, changed) });
            }
            if (path === "/auto" && req.method === "POST") {
                const { db, changed, result } = await update((d) => setAuto(d, body, user, now, tz), { tz });
                return json({ now, made: result.map((x) => x.id), state: await stateFor(metaOf(db), epoch, v, changed) });
            }
            if (path === "/reset" && req.method === "POST") {
                if (user.role !== "Admin") return json({ error: "Only an admin can reset the data" }, 403);
                const { db } = await update((d) => { const n = initDb(now, tz); for (const k of Object.keys(d)) delete d[k]; Object.assign(d, n); }, { tz, reset: true });
                return json({ now, state: await stateFor(metaOf(db), "", NaN) });
            }
            return json({ error: "Not found" }, 404);
        } catch (ex) {
            if (ex instanceof HttpError) return json({ error: ex.message }, ex.status);
            console.error(ex);
            return json({ error: "Server error - please try again" }, 500);
        }
    }

    return { handle, tick, update, readMeta };
}
