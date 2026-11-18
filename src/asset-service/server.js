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
   asset-service has its
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
  database: process.env.PG_DATABASE || "asset_db",
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
        CREATE TABLE IF NOT EXISTS assets (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      if (natsEvents.enabled) await natsEvents.start(pool);
      console.log("Asset Service: assets table ready");
      return;
    } catch (err) {
      console.log(
        `Asset Service: Postgres not ready yet (attempt ${attempt}/${maxRetries}): ${err.message}`
      );
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

// Startup occurs after table initialization at the bottom of this file.

/* =========================
   INCIDENT SERVICE URL
   Used for inter-service
   communication
========================= */
const INCIDENT_SERVICE_URL =
  process.env.INCIDENT_SERVICE_URL || "http://localhost:5002";

const PORT = 5001;

/* =========================
   CREATE ASSET
========================= */
app.post("/api/asset", async (req, res) => {
  const { name, type } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      'INSERT INTO assets (name, type) VALUES ($1, $2) RETURNING id, name, type, created_at AS "createdAt"',
      [name, type]
    );
    await natsEvents.enqueue(client, "created", result.rows[0]);
    await client.query("COMMIT");
    await cache.invalidate("assets:list");
    res.send(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Create asset failed:", err);
    res.status(500).send("Asset creation failed");
  } finally { client.release(); }
});

/* =========================
   GET ALL ASSETS WITH
   INCIDENTS
   Calls incident-service
   via HTTP to get incidents
========================= */
app.get("/api/data", async (req, res) => {
  let rows = await cache.getJson("assets:list");
  if (rows === null) {
    ({ rows } = await pool.query(
      'SELECT id, name, type, created_at AS "createdAt" FROM assets ORDER BY id'
    ));
    await cache.setJson("assets:list", rows);
  }
  const result = [];

  for (let asset of rows) {
    // Call incident-service to get incidents for this asset
    try {
      const incidentRes = await fetch(
        `${INCIDENT_SERVICE_URL}/incidents/${asset.id}`
      );
      asset.incidents = await incidentRes.json();
    } catch (err) {
      console.log(`Could not fetch incidents for asset ${asset.id}:`, err.message);
      asset.incidents = [];
    }

    result.push(asset);
  }

  res.send(result);
});

/* =========================
   UPDATE ASSET
========================= */
app.put("/api/asset/:id", async (req, res) => {
  const { id } = req.params;
  const { name, type } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM assets WHERE id = $1 FOR UPDATE", [id]);
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).send("Asset not found");
    }
    const current = existing.rows[0];
    const result = await client.query(
      'UPDATE assets SET name = $1, type = $2 WHERE id = $3 RETURNING id, name, type, created_at AS "createdAt"',
      [name || current.name, type || current.type, id]
    );
    await natsEvents.enqueue(client, "updated", result.rows[0]);
    await client.query("COMMIT");
    await cache.invalidate("assets:list");
    res.send(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Update asset failed:", err);
    res.status(500).send("Asset update failed");
  } finally { client.release(); }
});

/* =========================
   DELETE ASSET
   Enqueues JetStream cleanup in
   the same PostgreSQL transaction
========================= */
app.delete("/api/asset/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("DELETE FROM assets WHERE id = $1 RETURNING id, name, type", [id]);
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).send("Asset not found");
    }
    await natsEvents.enqueue(client, "deleted", result.rows[0]);
    await client.query("COMMIT");
    await cache.invalidate("assets:list");
    if (!natsEvents.enabled) {
      // Backward compatibility ONLY when NATS is off. Never do both: one source of deletion.
      try {
        const response = await fetch(`${INCIDENT_SERVICE_URL}/incidents/asset/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (err) { console.warn(`Legacy incident cleanup failed for asset ${id}:`, err.message); }
    }
    res.send(natsEvents.enabled ? "Asset deleted; incident cleanup queued" : "Asset deleted");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Delete asset failed:", err);
    res.status(500).send("Asset deletion failed");
  } finally { client.release(); }
});

/* =========================
   START SERVER
========================= */
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Asset Service running on port ${PORT}`);
    console.log(`Incident Service URL: ${INCIDENT_SERVICE_URL}`);
  });
}).catch((err) => { console.error("Asset Service startup failed:", err); process.exit(1); });
