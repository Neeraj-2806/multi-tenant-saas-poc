# NATS JetStream integration — Asset / Incident Services

## Behavior

- `POST /api/asset` commits an asset and an `asset.created` event to the **same PostgreSQL transaction**.
- `PUT /api/asset/:id` commits an updated asset and an `asset.updated` event in the same transaction.
- `DELETE /api/asset/:id` commits the asset deletion and an `asset.deleted` event in the same transaction.
- A background outbox dispatcher publishes to NATS JetStream and deletes outbox rows **only after a publish acknowledgement**. If NATS is down, rows remain and are retried.
- Incident Service has a durable JetStream pull consumer, filtered to one tenant's events. It **logs** created/updated events; for deleted events it deletes matching `incidents.asset_id` rows and invalidates `incidents:asset:<assetId>` in Dragonfly. It ACKs after processing.
- When `nats.enabled=false` existing behavior is retained: Asset Service invokes Incident Service's legacy HTTP DELETE endpoint. When true, it no longer performs HTTP deletion (eventual consistency).
- Tenant identity comes **only from the per-deployment trusted `PG_SCHEMA` environment configuration**, not from HTTP input. Event subjects: `tenants.<schema>.assets.created|updated|deleted`.

## Deployment order (Minikube)

1. Keep the working tenant-specific PostgreSQL credentials/schema and **Dragonfly ACL users and Secrets** in place; verify both tenant applications still work before NATS rollout.
2. Install NATS **with JetStream enabled** and create the `ASSET_EVENTS` stream before turning on `nats.enabled` in either service.
3. Build/load the updated backend images, upgrade both tenant releases with explicit NATS Helm values, and verify the consumer API in running logs.
4. Run create/update/delete, cross-tenant, and NATS outage/recovery tests. The app does not create the shared stream.

If you enable NATS before its stream exists, Asset Service retains events in its PostgreSQL outbox until publishing succeeds; Incident Service retries startup. That is a safe fallback, **not** a replacement for creating the stream first.

## Prerequisites (Minikube)

1. Install a NATS server with **JetStream enabled**, including persistent JetStream storage. Configure your NATS Helm release with the maintained official chart for your environment; verify chart values for the version you select. Example intended NATS service is `nats.nats.svc.cluster.local:4222`. This ZIP does not install the NATS server.
2. Create a file-backed JetStream stream **named `ASSET_EVENTS`** with subjects `tenants.*.assets.*`, retention limits sized for your demo, and adequate duplicate window. Example with the `nats` CLI connected to the server:

   ```bash
   nats stream add ASSET_EVENTS --subjects 'tenants.*.assets.*' --storage file --retention limits --defaults
   nats stream info ASSET_EVENTS
   ```

   CLI switches can differ by version; use `nats stream add --help` as needed. The application does **not** auto-create the shared stream. The first Incident Service start attempts to create its per-tenant durable consumer (`incident_tenant_a`, `incident_tenant_b`).
3. Rebuild and load updated images into Minikube from `src/asset-service` and `src/incident-service`. `nats` is a new npm dependency; `Dockerfile` uses `npm install --omit=dev`.

   ```bash
   eval "$(minikube docker-env)"
   docker build -t asset-service:nats-v1 src/asset-service
   docker build -t incident-service:nats-v1 src/incident-service
   ```

4. Upgrade **each tenant's existing Helm releases** using their currently working, tenant-specific PostgreSQL and Dragonfly values. Do **not** discard your previous Helm overrides. With your normal values files / image settings, add these illustrative overrides:

   ```bash
   # Tenant A (platform) and Tenant B (tenant-b): repeat with proper namespace, image and existing values.
   helm upgrade asset-service src/asset-service/chart -n platform --reuse-values \
     --set image.tag=nats-v1 --set nats.enabled=true \
     --set nats.url=nats://nats.nats.svc.cluster.local:4222 \
     --set nats.stream=ASSET_EVENTS
   helm upgrade incident-service src/incident-service/chart -n platform --reuse-values \
     --set image.tag=nats-v1 --set nats.enabled=true \
     --set nats.url=nats://nats.nats.svc.cluster.local:4222 \
     --set nats.stream=ASSET_EVENTS
   ```

   **Note:** `helm upgrade --reuse-values` keeps the release's previous values and should not be relied on to introduce new chart defaults. Explicitly set `nats.enabled`, `nats.url`, and `nats.stream` as above and check the resulting `helm get values -n <namespace> <release> -a`. Where supported by your Helm version, `--reset-then-reuse-values` can help incorporate new defaults, but first compare the generated manifests and preserve existing PostgreSQL and Dragonfly overrides. If an image repository is blank or old release values are missing, supply the complete previous image/DB/cache settings. Do not blindly apply these illustrative commands in production.
5. Observe logs:

   ```bash
   kubectl logs -n platform deployment/asset-service -f
   kubectl logs -n platform deployment/incident-service -f
   kubectl logs -n tenant-b deployment/incident-service -f
   ```

## Consumer compatibility check

The Incident Service code uses `nats@^2.29.3` (`js.consumers.get(stream, durable)` then `consumer.consume(...)`). This was not integration-tested against a live JetStream server. **Validate it in Minikube**: check subscriber logs for `[NATS] listening for tenants.tenant_a.assets.*` (and `tenant_b`), publish each event, and confirm consumption/ACK. If the API is incompatible, fix against the **installed** client version rather than relying on error-message matching alone. The current consumer creation recognizes several not-found error shapes; test initial consumer creation and restart with an existing durable consumer.

Failed events are NAKed with a **5-second retry delay** (`m.nak(5000)`), with a consumer `max_deliver` of 10. At the maximum delivery count, investigate and recover the message manually; do not assume infinite retries.

## Demo / verification

- In Tenant A UI, create an asset. Expect `[NATS] published tenants.tenant_a.assets.created` and `[NATS] received asset.created...`.
- Update its name. Expect published and received `asset.updated` logs, **no change to incident rows** (they store only `asset_id`).
- Add incidents for the asset and call `GET /api/data` to populate cache. Delete the asset in Tenant A UI. The outbox publishes `asset.deleted`; Tenant A incident consumer deletes matching incidents. Check with SQL against `tenant_a.incidents` and verify the Dragonfly key invalidated.
- Repeat with Tenant B, and check that Tenant A rows are unchanged.
- Test resiliency: stop the NATS server, delete an asset, confirm an outbox row remains in the tenant schema; restart NATS and confirm it is published and processed. Consumption is **eventual**, not synchronously complete by the time HTTP DELETE returns.

## Reliability and security notes

- Uses an outbox + JetStream persistent stream + durable ACK consumer for **at-least-once** delivery. Duplicate deletes are harmless. The outbox is in the same tenant schema as `assets`.
- In a hard crash between deleting incidents from PostgreSQL and invalidating Dragonfly, the incident cache can remain stale for up to its existing TTL. Improve with a persistent invalidation outbox if stricter consistency is required.
- Limit JetStream message retention, monitor outbox row counts and consumer lag, and set up retry/dead-letter handling in production. The consumer defaults to 10 delivery attempts; failures after that require operator intervention.
- **Event ordering:** multiple Asset Service replicas can dispatch outbox entries concurrently. Creation/update handlers currently only log, and repeated deletion is safe, but do not assume per-asset ordering. If later updates change incident state, implement an explicit ordering/versioning strategy.
- **Dragonfly local tests:** caching requires a configured ACL username/password when enabled. A plain unauthenticated Redis stand-in will not start with the current `cache.js` setup; use tenant ACL credentials or explicitly disable cache for that particular isolated test.
- **Subject prefixes alone are not an authorization boundary.** For real tenant isolation, enable NATS authentication and **server-enforced** publish/subscribe and JetStream API permissions, use tenant-scoped NATS credentials/Secrets, and restrict pod network access. An untrusted pod can otherwise forge a tenant subject and `tenantId`, triggering deletion in another tenant. Tell Pratik this must be secured before production. Helm supports `nats.existingSecret` with `username` and `password` keys. Never commit credentials.
- For a real production rollout, migration and operational concerns include outbox pruning/monitoring, permission provisioning, stream ownership, secret rotation, and automated tests with a live NATS + PostgreSQL + Dragonfly stack.
- The original Dockerfiles use Node 18, which is EOL; update to a supported Node LTS and validate app dependencies before production.
- Existing unresolved CI concern: ensure OCI Helm chart versions are bumped on chart changes before publishing to immutable ECR.
