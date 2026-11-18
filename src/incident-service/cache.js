// Shared Dragonfly (Redis protocol) cache helper.
// Every deployed tenant has a fixed PG_SCHEMA; it also determines the cache key namespace.
// Cached data is an optimization only: PostgreSQL remains the source of truth.
const { createClient } = require("redis");

const enabled = process.env.CACHE_ENABLED === "true";
const schema = process.env.PG_SCHEMA || "public";
const ttlSeconds = Number(process.env.CACHE_TTL_SECONDS || 60);
if (enabled && (!process.env.CACHE_URL || schema === "public")) {
  throw new Error("CACHE_ENABLED requires CACHE_URL and a tenant-specific PG_SCHEMA");
}
// The shared cache must authenticate as a restricted per-tenant ACL user.
// Merely adding a tenant prefix to keys does not protect cross-tenant data.
if (enabled && (!process.env.CACHE_USERNAME || !process.env.CACHE_PASSWORD)) {
  throw new Error("CACHE_ENABLED requires CACHE_USERNAME and CACHE_PASSWORD for tenant ACL isolation");
}
if (enabled && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400)) {
  throw new Error("CACHE_TTL_SECONDS must be an integer between 1 and 86400");
}

// Key prefix prevents accidental collisions. Enforce tenant ACLs separately on Dragonfly;
// prefixes alone are NOT a security boundary.
const prefix = `tenant:${schema}:`;
let client;
if (enabled) {
  client = createClient({
    url: process.env.CACHE_URL,
    ...(process.env.CACHE_USERNAME ? { username: process.env.CACHE_USERNAME } : {}),
    ...(process.env.CACHE_PASSWORD ? { password: process.env.CACHE_PASSWORD } : {}),
    // Never queue cache commands during an outage: PostgreSQL stays authoritative.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1500,
      // Keep reconnecting after outages, including when Dragonfly starts late.
      reconnectStrategy: (retries) => Math.min(Math.max(retries, 1) * 200, 5000),
    },
  });
  client.on("error", (err) => console.warn("Dragonfly connection:", err.message));
  client.connect().catch((err) => console.warn("Dragonfly unavailable; using PostgreSQL:", err.message));
}

const key = (suffix) => `${prefix}${suffix}`;
async function getJson(suffix) {
  if (!client?.isReady) return null;
  try {
    const value = await client.get(key(suffix));
    return value === null ? null : JSON.parse(value);
  } catch (err) {
    console.warn("Dragonfly read failed:", err.message);
    return null;
  }
}
async function setJson(suffix, value) {
  if (!client?.isReady) return;
  try {
    await client.set(key(suffix), JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.warn("Dragonfly write failed:", err.message);
  }
}
async function invalidate(suffix) {
  if (!client?.isReady) return;
  try {
    await client.del(key(suffix));
  } catch (err) {
    console.warn("Dragonfly invalidation failed:", err.message);
  }
}
module.exports = { getJson, setJson, invalidate };
