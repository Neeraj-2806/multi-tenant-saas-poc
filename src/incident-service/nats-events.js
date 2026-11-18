// Durable JetStream consumer. Only this tenant's subject is processed.
const { connect, StringCodec, AckPolicy, DeliverPolicy } = require("nats");
const enabled = process.env.NATS_ENABLED === "true";
const schema = process.env.PG_SCHEMA || "public";
const stream = process.env.NATS_STREAM || "ASSET_EVENTS";
const durable = `incident_${schema}`;
const sc = StringCodec();

async function run(pool, cache) {
  if (!enabled) { console.log("[NATS] disabled"); return; }
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema === "public")
    throw new Error("NATS requires a tenant-specific PG_SCHEMA");
  if (!process.env.NATS_URL) throw new Error("NATS_URL required");
  const opts = { servers: process.env.NATS_URL, name: `incident-service-${schema}`,
    maxReconnectAttempts: -1, reconnectTimeWait: 2000 };
  if (process.env.NATS_USERNAME && process.env.NATS_PASSWORD) {
    opts.user = process.env.NATS_USERNAME; opts.pass = process.env.NATS_PASSWORD;
  }
  // Automatically retries initial connection/stream creation errors.
  while (true) {
    let nc;
    try {
      nc = await connect(opts);
      const js = nc.jetstream();
      const jsm = await nc.jetstreamManager();
      const subject = `tenants.${schema}.assets.*`;
      try {
        await jsm.consumers.info(stream, durable);
      } catch (err) {
        // Create a durable filtered consumer. For least-privilege deployments,
        // provision it separately and grant consumer access instead.
        if (String(err.message).includes("consumer not found") || String(err.code) === "404" || err.api_error?.err_code === 10014) {
          await jsm.consumers.add(stream, { durable_name: durable,
            filter_subject: subject, ack_policy: AckPolicy.Explicit,
            deliver_policy: DeliverPolicy.All, max_deliver: 10, ack_wait: 30_000_000_000 });
        } else throw err;
      }
      const consumer = await js.consumers.get(stream, durable);
      console.log(`[NATS] listening for ${subject}`);
      const messages = await consumer.consume({ max_messages: 10 });
      for await (const m of messages) {
        try {
          const event = JSON.parse(sc.decode(m.data));
          if (event.tenantId !== schema || !/^asset\.(created|updated|deleted)$/.test(event.type) ||
              m.subject !== `tenants.${schema}.assets.${event.type.split(".")[1]}` ||
              !/^[0-9]+$/.test(String(event.assetId))) {
            console.error("[NATS] invalid or cross-tenant asset event; terminating delivery");
            m.term(); continue;
          }
          if (event.type === "asset.deleted") {
            const result = await pool.query("DELETE FROM incidents WHERE asset_id = $1", [String(event.assetId)]);
            await cache.invalidate(`incidents:asset:${event.assetId}`);
            console.log(`[NATS] deleted ${result.rowCount} incidents for asset ${event.assetId} tenant=${schema}`);
          } else {
            // No redundant asset_name column in incidents. Only log these events.
            console.log(`[NATS] received ${event.type} asset=${event.assetId} tenant=${schema}`);
          }
          m.ack();
        } catch (err) {
          console.error("[NATS] event processing failed; will retry:", err.message);
          // Avoid a rapid burst of failed deliveries (5-second retry delay).
          m.nak(5000);
        }
      }
    } catch (err) {
      console.error("[NATS] subscriber disconnected/error; retrying:", err.message);
    } finally { if (nc) await nc.close().catch(() => {}); }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}
module.exports = { enabled, run };
