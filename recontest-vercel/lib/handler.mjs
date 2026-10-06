// Connects the API to Upstash Redis using the environment variables Vercel adds
// when you connect an Upstash Redis store to the project (Storage tab / Marketplace).
import { Redis } from "@upstash/redis";
import { HttpError } from "./recon-core.mjs";
import { createRedisApi } from "./redis-api.mjs";

let client = null;
function upstash() {
    if (client) return client;
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
        throw new HttpError(500, "Storage is not connected. In Vercel open this project → Storage → connect Upstash Redis, then redeploy.");
    }
    const r = new Redis({ url, token, automaticDeserialization: false });
    client = {
        mget: (...keys) => r.mget(...keys),
        eval: (script, keys, args) => r.eval(script, keys, args),
        hvals: (key) => r.hvals(key),
        hget: (key, field) => r.hget(key, field),
        idsAfter: (key, score) => r.zrange(key, `(${score}`, "+inf", { byScore: true }),
        hmget: async (key, fields) => {
            const res = await r.hmget(key, ...fields);
            if (Array.isArray(res)) return res;
            return fields.map((f) => (res && res[f] != null ? res[f] : null));   // some client versions answer with an object
        },
    };
    return client;
}

const api = createRedisApi(upstash);

export const handler = { fetch: (req) => api.handle(req) };
