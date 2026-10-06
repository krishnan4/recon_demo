// Runs every minute on Netlify (production deploys only). When Auto Generate is on and a run
// is due, it queues the next batch of reports — even when no browser has the portal open.
import { getStore } from "@netlify/blobs";
import { createApi } from "../lib/recon-core.mjs";

const api = createApi(() => getStore({ name: "recontest", consistency: "strong" }));

export default async () => {
    const result = await api.tick();
    if (result.ran) console.log(`Auto generate: ${result.made} report(s) queued`);
};

export const config = { schedule: "* * * * *" };
