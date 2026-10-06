// ReconTest API: /api/login, /api/state, /api/reports, /api/reports/:id/retry, /api/auto, /api/reset
import { getStore } from "@netlify/blobs";
import { createApi } from "../lib/recon-core.mjs";

const api = createApi(() => getStore({ name: "recontest", consistency: "strong" }));

export default (req) => api.handle(req);

export const config = { path: "/api/*" };
