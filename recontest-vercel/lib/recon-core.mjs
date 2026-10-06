/* ReconTest — shared server logic (users, validation, scheduling, auto generate).
   Used by the Vercel API (lib/redis-api.mjs). The report list is stored on the server, so every
   browser and every laptop sees the same list. Report contents (rows, Excel, CSV) are still
   built in the browser from the report record, so only the small list is stored here. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ── settings ──────────────────────────────────────────────────────────────────
export const USERS = {
    melon12: { password: "Firstmelon@123", name: "Melon Tester", role: "Recon Analyst" },
    admin: { password: "admin@123", name: "Administrator", role: "Admin" },
};
const SECRET = process.env.RECON_SECRET || "recontest-demo-secret-change-me"; // set RECON_SECRET in Netlify to change it
const TOKEN_DAYS = 7;
const MIN_MS = 2000, MAX_MS = 6000;      // time to generate one report
const SLOTS = 2;                          // reports generated at the same time
const MAX_PER_REQUEST = 100;
export const MAX_KEEP = 3000;             // oldest reports are removed beyond this
export const AUTO_MINUTES = [1, 2, 5, 10, 15, 30];
const AUTO_PERIODS = ["yesterday", "today", "mtd"];
const BLOB_KEY = "db";

const NETWORKS = ["CARD", "UPI", "IMPS", "NEFT/RTGS", "ATM", "POS", "AEPS"];
const DATE_TYPES = ["File Date", "Transaction Date", "Settlement Date"];
const REPORT_TYPES = ["Pregen Report", "Custom Report"];
const REPORTS = {
    MAT: "Matched Transactions", UNM: "Unmatched Transactions", EXC: "Exception Report", FMR: "Force Match Report",
    PAY: "Payouts", STL: "Settlement Summary", CHB: "Chargebacks", GLR: "GL Reconciliation", VCH: "Voucher File",
};
const GENERATE_ALL = Object.keys(REPORTS).filter((c) => c !== "VCH");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── helpers ───────────────────────────────────────────────────────────────────
const DAY = 86400000;
const dn = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
const parts = (n) => { const d = new Date(n * DAY); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };
const fmtD = (n) => { const p = parts(n); return `${p.d}/${MONTHS[p.m]}/${p.y}`; };
/** The user's calendar day. tz is the browser's getTimezoneOffset() in minutes (India = -330). */
const localDay = (ms, tz) => Math.floor((ms - tz * 60000) / DAY);
const clampTz = (v) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= 840 ? Math.round(n) : 0; };

function rng(seed) {                      // mulberry32 — same as the page
    let a = seed >>> 0;
    const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (arr) => arr[Math.floor(next() * arr.length)] };
}

export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

// ── login tokens ──────────────────────────────────────────────────────────────
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (s) => createHmac("sha256", SECRET).update(s).digest("base64url");
export function makeToken(username, now = Date.now()) {
    const body = b64(JSON.stringify({ u: username, exp: now + TOKEN_DAYS * DAY }));
    return `${body}.${sign(body)}`;
}
export function readToken(token, now = Date.now()) {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const want = Buffer.from(sign(body)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
        const { u, exp } = JSON.parse(Buffer.from(body, "base64url").toString());
        return USERS[u] && exp > now ? { username: u, ...USERS[u] } : null;
    } catch { return null; }
}

// ── the data ──────────────────────────────────────────────────────────────────
// Auto Generate is ON from the start: every 2 minutes, all reports, today's date — nobody has to tick anything.
// (It can still be switched off on the Report Download page.)
const AUTO_DEFAULT = {
    on: true, minutes: 2, period: "today", networkType: "CARD", reportType: "Pregen Report", reportName: "ALL",
    dateType: "File Date", tz: 0, user: "system", last: 0, next: 0, runs: 0, lastError: ""
};

function summaryText(title, frm, to) {
    if (frm === to) return `${title} on ${fmtD(frm)}`;
    const p = parts(frm), last = Date.UTC(p.y, p.m + 1, 0) / DAY;
    if (p.d === 1 && to === last) return `${title} in ${MONTHS[p.m]} ${p.y}`;
    return `${title} from ${fmtD(frm)} to ${fmtD(to)}`;
}
function newReport(db, code, network, reportType, dateType, frm, to, user, createdMs) {
    return {
        id: db.nextId++, code, title: REPORTS[code], network, reportType, dateType, from: frm, to,
        summary: summaryText(REPORTS[code], frm, to), user, created: createdMs, start: createdMs, end: createdMs,
        failed: null, rev: db.version + 1
    };
}
export function initDb(now = Date.now(), tz = 0) {
    const db = { epoch: randomBytes(6).toString("hex"), version: 0, nextId: 350560, slots: Array(SLOTS).fill(0), reports: [], auto: { ...AUTO_DEFAULT, tz } };
    // the same sample history the single-file portal used to create
    const r = rng(2026), today = localDay(now, tz);
    let day = today - 95;
    while (true) {
        day += r.pick([1, 1, 1, 2]);
        if (day >= today) break;
        const code = r.pick(["PAY", "PAY", "PAY", "MAT", "UNM", "STL", "EXC", "CHB", "GLR"]);
        const p = parts(day);
        let frm = Date.UTC(p.y, p.m, 1) / DAY, to = p.d > 1 ? day - 1 : day;
        if (r.next() < 0.15) frm = to = day - 1;
        const at = Date.UTC(p.y, p.m, p.d, 8, r.next() < 0.8 ? 25 : r.int(30, 59)) + tz * 60000;
        const rep = newReport(db, code, r.pick(["CARD", "CARD", "CARD", "UPI", "IMPS", "NEFT/RTGS"]), "Pregen Report", "File Date", frm, to, "system", at);
        rep.end = at + r.int(3, 40) * 1000;
        rep.rev = 0;
        if (r.next() < 0.03) rep.failed = "Network file not received for the selected date";
        db.reports.push(rep);
    }
    return db;
}
const autoCfg = (db) => (db.auto = { ...AUTO_DEFAULT, ...(db.auto || {}) });

function schedule(db, rep, now) {
    if (!Array.isArray(db.slots) || db.slots.length !== SLOTS) db.slots = Array(SLOTS).fill(0);
    let i = 0;
    db.slots.forEach((t, k) => { if (t < db.slots[i]) i = k; });
    rep.start = Math.max(now + 300, db.slots[i]);
    rep.end = Math.round(rep.start + MIN_MS + Math.random() * (MAX_MS - MIN_MS));
    db.slots[i] = rep.end;
}
function prune(db) {
    if (db.reports.length > MAX_KEEP) db.reports.splice(0, db.reports.length - MAX_KEEP);
}

export function createReports(db, body, user, now, tz) {
    const network = body.networkType;
    if (!NETWORKS.includes(network)) bad("Select a Network Type");
    if (!REPORT_TYPES.includes(body.reportType)) bad("Select a Report Type");
    const codes = !body.reportName || body.reportName === "ALL" ? GENERATE_ALL : [body.reportName];
    if (codes.some((c) => !REPORTS[c])) bad("Select a Report Name");
    if (!DATE_TYPES.includes(body.dateType)) bad("Select a Date Type");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.fromDate || "")) bad("From Date must be a date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.toDate || "")) bad("To Date must be a date");
    const frm = dn(body.fromDate), to = dn(body.toDate);
    if (to < frm) bad("To Date cannot be before From Date");
    if (to > localDay(now, tz)) bad("To Date cannot be in the future");
    if (to - frm > 92) bad("Choose a period of at most 93 days");
    const ranges = body.splitByDay ? Array.from({ length: to - frm + 1 }, (_, i) => [frm + i, frm + i]) : [[frm, to]];
    if (ranges.length * codes.length > MAX_PER_REQUEST) bad(`That would create ${ranges.length * codes.length} reports - the limit is ${MAX_PER_REQUEST} at a time`);
    const out = [];
    for (const [a, b] of ranges) for (const c of codes) {
        const rep = newReport(db, c, network, body.reportType, body.dateType, a, b, user, now);
        schedule(db, rep, now);
        out.push(rep);
    }
    db.reports.push(...out);
    prune(db);
    return out;
}

export function retryReport(db, id, user, now) {
    const rep = db.reports.find((r) => r.id === id);
    if (!rep) throw new HttpError(404, `Report ${id} not found`);
    if (!rep.failed || now < rep.end) bad(`Report ${id} has not failed`);
    rep.failed = null; rep.created = now; rep.user = user; rep.rev = db.version + 1;
    schedule(db, rep, now);
    return rep;
}

function autoRange(period, now, tz) {
    const t = localDay(now, tz);
    if (period === "today") return [t, t];
    if (period === "mtd") { const p = parts(t); return [Date.UTC(p.y, p.m, 1) / DAY, t]; }
    return [t - 1, t - 1];
}
const iso = (n) => new Date(n * DAY).toISOString().slice(0, 10);

/** Runs one auto batch if it is due. Returns the new reports, or null when nothing was due. */
export function runAuto(db, now, force = false) {
    const a = autoCfg(db);
    // the scheduler fires about once a minute, so a run is "due" a little before the exact time
    if (!a.on || (!force && now < a.next - 20000)) return null;
    a.last = now;
    a.next = now + a.minutes * 60000;
    const [f, t] = autoRange(a.period, now, a.tz);
    try {
        const made = createReports(db, {
            networkType: a.networkType, reportType: a.reportType, reportName: a.reportName, dateType: a.dateType,
            fromDate: iso(f), toDate: iso(t)
        }, `auto:${a.user || "system"}`, now, a.tz);
        a.runs += 1; a.lastError = "";
        return made;
    } catch (ex) {
        a.lastError = ex.message;
        return [];
    }
}

export function setAuto(db, patch, user, now, tz) {
    const a = autoCfg(db);
    const next = { ...a };
    for (const k of ["networkType", "reportType", "reportName", "dateType", "period"]) if (patch[k] !== undefined) next[k] = String(patch[k]);
    if (patch.minutes !== undefined) {
        const m = Number(patch.minutes);
        if (!(m >= 1 && m <= 60)) bad("Auto generate interval must be 1 to 60 minutes");
        next.minutes = m;
    }
    if (!NETWORKS.includes(next.networkType)) bad("Select a Network Type");
    if (!REPORT_TYPES.includes(next.reportType)) bad("Select a Report Type");
    if (next.reportName !== "ALL" && !REPORTS[next.reportName]) bad("Select a Report Name");
    if (!DATE_TYPES.includes(next.dateType)) bad("Select a Date Type");
    if (!AUTO_PERIODS.includes(next.period)) bad("Select a period");
    let made = [];
    if (patch.on === true) {
        Object.assign(a, next, { on: true, user: user.username, tz, runs: 0, last: 0, next: now, lastError: "" });
        made = runAuto(db, now, true) || [];         // first batch straight away
    } else if (patch.on === false) {
        Object.assign(a, next, { on: false });
    } else {
        const minutesChanged = next.minutes !== a.minutes;
        Object.assign(a, next);
        if (a.on && minutesChanged) a.next = (a.last || now) + a.minutes * 60000;
    }
    return made;
}

/** What a browser needs: everything when it has nothing (or old data), otherwise only what changed. */
export function stateFor(db, epoch, v) {
    const full = epoch !== db.epoch || !Number.isFinite(v);
    const reports = full ? db.reports : db.reports.filter((r) => r.rev > v);
    return { full, epoch: db.epoch, version: db.version, maxKeep: MAX_KEEP, auto: autoCfg(db), reports };
}
