// PostgreSQL transactional outbox -> NATS JetStream (at-least-once delivery).
// Tenant isolation: all events are under the validated PG_SCHEMA subject.
const { connect, StringCodec } = require("nats");
const { randomUUID } = require("node:crypto");
const enabled = process.env.NATS_ENABLED === "true";
const stream = process.env.NATS_STREAM || "ASSET_EVENTS";
const schema = process.env.PG_SCHEMA || "public";
const subjects = { created: "created", updated: "updated", deleted: "deleted" };
const sc = StringCodec();
let nc, js, timer, publishing = false;

async function makeOutbox(pool) {
  // Created in the tenant's PostgreSQL schema through search_path.
  await pool.query(`CREATE TABLE IF NOT EXISTS asset_event_outbox (
    id UUID PRIMARY KEY, subject TEXT NOT NULL, payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function enqueue(client, action, asset) {
  if (!enabled) return;
  if (!subjects[action]) throw new Error(`Unknown asset event: ${action}`);
  const subject = `tenants.${schema}.assets.${action}`;
  const event = { eventId: randomUUID(), tenantId: schema, type: `asset.${action}`,
    assetId: String(asset.id), occurredAt: new Date().toISOString(),
    asset: action === "deleted" ? undefined : { id: asset.id, name: asset.name, type: asset.type } };
  await client.query("INSERT INTO asset_event_outbox (id, subject, payload) VALUES ($1, $2, $3)",
    [event.eventId, subject, JSON.stringify(event)]);
}

async function dispatch(pool) {
  if (!enabled || !js || publishing) return;
  publishing = true;
  try {
    for (let i = 0; i < 50; i++) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          "SELECT id, subject, payload FROM asset_event_outbox ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"
        );
        if (!rows.length) { await client.query("COMMIT"); break; }
        const event = rows[0];
        // JetStream publish acknowledgment comes BEFORE removing the outbox row.
        await js.publish(event.subject, sc.encode(JSON.stringify(event.payload)), { msgID: event.id });
        await client.query("DELETE FROM asset_event_outbox WHERE id = $1", [event.id]);
        await client.query("COMMIT");
        console.log(`[NATS] published ${event.subject} id=${event.id}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.warn("[NATS] outbox retry pending:", err.message);
        break;
      } finally { client.release(); }
    }
  } finally { publishing = false; }
}

async function start(pool) {
  if (!enabled) { console.log("[NATS] disabled; legacy HTTP deletion retained"); return; }
  if (!/^([a-z_][a-z0-9_]*)$/.test(schema) || schema === "public")
    throw new Error("NATS requires a tenant-specific PG_SCHEMA");
  if (!process.env.NATS_URL) throw new Error("NATS_URL required");
  await makeOutbox(pool);
  const opts = { servers: process.env.NATS_URL, name: `asset-service-${schema}`,
    maxReconnectAttempts: -1, reconnectTimeWait: 2000 };
  if (process.env.NATS_USERNAME && process.env.NATS_PASSWORD) {
    opts.user = process.env.NATS_USERNAME; opts.pass = process.env.NATS_PASSWORD;
  }
  // Database can keep accepting writes even if NATS is unavailable at startup.
  async function establish() {
    if (nc && !nc.isClosed()) return;
    try {
      nc = await connect(opts); js = nc.jetstream();
      console.log(`[NATS] connected (stream ${stream})`);
      nc.closed().then(() => { js = null; nc = null; }).catch(() => { js = null; nc = null; });
    } catch (err) { console.warn("[NATS] connect retry pending:", err.message); }
  }
  await establish();
  timer = setInterval(async () => {
    if (!js) await establish();
    await dispatch(pool).catch((err) => console.warn("[NATS] dispatch:", err.message));
  }, 1500);
  timer.unref?.();
  await dispatch(pool);
}
module.exports = { enabled, enqueue, start };
