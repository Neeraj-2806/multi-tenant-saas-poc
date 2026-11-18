# Dragonfly integration — Asset and Incident Services

## Source verification
The uploaded source includes `PG_SCHEMA` validation and PostgreSQL `search_path` in both backend `server.js` files, and the corresponding `postgres.schema`/`postgres.createSchema` Helm values.

## Changes
- Added `cache.js` to both services, using the Redis-compatible `redis` Node.js package.
- Asset Service: cache the PostgreSQL asset list queried by `GET /api/data` and invalidate it on asset create, update, or delete. Incident information is still loaded from Incident Service on each request (and can be served from its separate cache).
- Incident Service: cache `GET /incidents/:assetId`; invalidate that asset's incident cache after incident create, update, or delete, or after bulk removal for an asset.
- A single shared Dragonfly server is supported; every key starts with `tenant:<PG_SCHEMA>:`. Example keys: `tenant:tenant_a:assets:list` and `tenant:tenant_b:incidents:asset:1`.
- The cache has a configurable TTL (default 60 seconds). Cache failures fall back to PostgreSQL where applicable.
- Added optional Helm settings and ConfigMap variables, and optional `CACHE_PASSWORD` from a Kubernetes Secret.
- Existing PG_SCHEMA and all PostgreSQL/CRUD endpoints are preserved; no NATS, frontend, or standalone Dragonfly Helm deployment was added.

## Helm values for either backend (EXAMPLE, NOT YET INSTALLED)
```yaml
cache:
  enabled: true
  url: redis://dragonfly.platform.svc.cluster.local:6379
  ttlSeconds: 60
  username: tenant_a_cache_user
  existingSecret: tenant-a-dragonfly-credentials
```
Apply the analogous values for Tenant B (its own username/Secret), in the correct namespace. The secret must have a `password` key. Only enable cache after verifying the Dragonfly service address and credentials.

## Security and limitations
- **Key prefixes do not enforce access control.** A shared Dragonfly server must enforce tenant-scoped ACLs (including access to key patterns and restricting administrative commands), separate credentials, and network policies. Verify access denial across tenants before using real data.
- The current implementation is an introductory cache-aside proof of concept. Invalidation may race with overlapping reads/writes and can yield stale data for up to the TTL. Do not treat this as production-validated caching.
- This ZIP does not install Dragonfly on Minikube or update your running Helm releases. Its caching feature remains disabled by default; PostgreSQL behavior should stay unchanged until you enable and test it.
- Node.js syntax checks were run. Live database, Dragonfly, Kubernetes, Helm deployment and isolation tests have **not** been run here.
- After unpacking, rebuild new Docker images before a Helm upgrade; preserve your existing tenant-specific database values and Kubernetes secrets (`--reuse-values` where appropriate).

## Reliability + ACL update (2026-11-15)
- Both `cache.js` modules now retry reconnections indefinitely, with a delay capped at 5000 ms. If Dragonfly starts late or restarts, the cache client will recover without requiring an application Pod restart.
- `disableOfflineQueue: true` prevents outdated cache commands from piling up and being replayed after an outage. `getJson`, `setJson` and `invalidate` already check readiness and catch failures; PostgreSQL remains the source of truth.
- With `CACHE_ENABLED=true`, both services now require a tenant-specific `CACHE_USERNAME` and `CACHE_PASSWORD`; the Helm templates also require `cache.username` and `cache.existingSecret`. This prevents accidentally deploying caching with an unrestricted default user.
- **ACL enforcement is server-side and is NOT installed by these application charts.** Provision one restricted Dragonfly ACL user per tenant; examples (illustrative, replace passwords and apply securely using an admin connection):

```redis
ACL SETUSER tenant_a_cache_user reset on >REPLACE_WITH_SECRET_A ~tenant:tenant_a:* -@all +GET +SET +DEL +PING
ACL SETUSER tenant_b_cache_user reset on >REPLACE_WITH_SECRET_B ~tenant:tenant_b:* -@all +GET +SET +DEL +PING
```

- Confirm on your Dragonfly version using `ACL DRYRUN tenant_a_cache_user GET tenant:tenant_b:assets:list` (must be denied), plus an allowed key check. Verify persistence of ACL settings across restart and disable/restrict the default user; protect administrative credentials separately.
- The stale-cache race and default 60-second TTL are intentionally unchanged for the PoC.
- Cache is still disabled by default; **no Dragonfly installation or live Minikube test is performed by this ZIP**.
