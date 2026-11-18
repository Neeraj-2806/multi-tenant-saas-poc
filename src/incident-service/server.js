const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const cache = require("./cache");
const natsEvents = require("./nats-events");
const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   POSTGRES CONFIG
   incident-service has its
   own dedicated database
========================= */
// One deployed service instance serves one tenant schema.
// Validate the identifier before using it in a PostgreSQL connection option or DDL.
const PG_SCHEMA = process.env.PG_SCHEMA || "public";
if (!/^[a-z_][a-z0-9_]*$/.test(PG_SCHEMA) || PG_SCHEMA.startsWith("pg_")) {
  throw new Error(`Invalid PG_SCHEMA: ${PG_SCHEMA}`);
}
// For local Minikube tests only; GitOps onboarding will create schemas later.
const PG_CREATE_SCHEMA = process.env.PG_CREATE_SCHEMA === "true";

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "incident_db",
  // Applied to every pooled connection, including all existing CRUD queries.
  options: `-c search_path=${PG_SCHEMA}`,
});

pool.on("error", (err) => console.log("Postgres Error:", err));

/* =========================
   ENSURE TABLE EXISTS
   Keeps parity with Redis
   version, which needed no
   separate schema step
========================= */
const initDb = async () => {
  const maxRetries = 10;
  const delayMs = 3000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (PG_CREATE_SCHEMA && PG_SCHEMA !== "public") {
        // Identifier is safe because PG_SCHEMA was strictly validated above.
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${PG_SCHEMA}"`);
      }
      await pool.query(`
        CREATE TABLE IF NOT EXISTS incidents (
          id SERIAL PRIMARY KEY,
          asset_id TEXT NOT NULL,
          issue TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_incidents_asset_id ON incidents (asset_id);
      `);
      console.log("Incident Service: incidents table ready");
      return;
    } catch (err) {
      console.log(
        `Incident Service: Postgres not ready yet (attempt ${attempt}/${maxRetries}): ${err.message}`
      );
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

// Subscriber starts after the database tables are initialized.

const PORT = 5002;

/* =========================
   CREATE INCIDENT
   Called by browser via Nginx
========================= */
app.post("/api/incident", async (req, res) => {
  const { assetId, issue } = req.body;
  const result = await pool.query(
    'INSERT INTO incidents (asset_id, issue) VALUES ($1, $2) RETURNING id, asset_id AS "assetId", issue, created_at AS "createdAt"',
    [assetId, issue]
  );
  await cache.invalidate(`incidents:asset:${assetId}`);
  res.send(result.rows[0]);
});

/* =========================
   GET INCIDENTS BY ASSET ID
   Called internally by
   asset-service only
========================= */
app.get("/incidents/:assetId", async (req, res) => {
  const { assetId } = req.params;
  const cacheKey = `incidents:asset:${assetId}`;
  let rows = await cache.getJson(cacheKey);
  if (rows === null) {
    ({ rows } = await pool.query(
      'SELECT id, asset_id AS "assetId", issue, created_at AS "createdAt" FROM incidents WHERE asset_id = $1 ORDER BY id',
      [assetId]
    ));
    await cache.setJson(cacheKey, rows);
  }
  res.send(rows);
});

/* =========================
   DELETE ALL INCIDENTS
   FOR AN ASSET
   Legacy endpoint (retained for
   NATS-disabled deployments).
   NATS uses durable consumer.
========================= */
app.delete("/incidents/asset/:assetId", async (req, res) => {
  const { assetId } = req.params;
  await pool.query("DELETE FROM incidents WHERE asset_id = $1", [assetId]);
  await cache.invalidate(`incidents:asset:${assetId}`);
  res.send("Incidents deleted for asset");
});

/* =========================
   UPDATE INCIDENT
   Called by browser via Nginx
========================= */
app.put("/api/incident/:assetId/:incidentId", async (req, res) => {
  const { assetId, incidentId } = req.params;
  const { issue } = req.body;
  const result = await pool.query(
    'UPDATE incidents SET issue = $1 WHERE id = $2 AND asset_id = $3 RETURNING id, asset_id AS "assetId", issue, created_at AS "createdAt"',
    [issue, incidentId, assetId]
  );
  if (result.rows.length === 0) return res.status(404).send("Incident not found");
  await cache.invalidate(`incidents:asset:${assetId}`);
  res.send("Incident updated");
});

/* =========================
   DELETE INCIDENT
   Called by browser via Nginx
========================= */
app.delete("/api/incident/:assetId/:incidentId", async (req, res) => {
  const { assetId, incidentId } = req.params;
  await pool.query("DELETE FROM incidents WHERE id = $1 AND asset_id = $2", [
    incidentId,
    assetId,
  ]);
  await cache.invalidate(`incidents:asset:${assetId}`);
  res.send("Incident deleted");
});

/* =========================
   START SERVER
========================= */
initDb().then(() => {
  app.listen(PORT, () => { console.log(`Incident Service running on port ${PORT}`); });
  // The subscriber reconnects if NATS is temporarily offline.
  natsEvents.run(pool, cache).catch((err) => console.error("NATS consumer failed:", err));
}).catch((err) => { console.error("Incident Service startup failed:", err); process.exit(1); });
