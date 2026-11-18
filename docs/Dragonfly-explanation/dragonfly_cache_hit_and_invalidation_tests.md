# Dragonfly Cache HIT and Cache Invalidation Tests

## Context: Our Minikube multi-tenant application

We have **one shared Dragonfly instance** and a shared CNPG PostgreSQL database. Tenant A's Asset Service and Incident Service run in the `platform` namespace, while Tenant B's services run in the `tenant-b` namespace. Tenant-specific Dragonfly ACL users limit access to each tenant's cache keys. Both services have Dragonfly caching enabled with a **60-second TTL**.

This document records **the two tests we performed using Tenant A's Asset Service**:

1. Cache HIT (checking whether repeat requests reuse cached data).
2. Cache invalidation (checking what happens to the cache after an asset changes).

> **Important:** Our observations confirm cache storage, expiration, and refreshed content. The tests support cache-hit and invalidation behavior but **do not conclusively prove** that a second response was served from cache or that the old key was deleted before being recreated. Backend HIT/MISS and invalidation logs would make those checks definitive.

---

## Test 1 — Cache HIT / Cache Reuse

### Objective

When Tenant A requests the same asset list twice within 60 seconds, Asset Service should reuse the Dragonfly cache rather than query PostgreSQL for the same asset list again.

### Expected request flow

```text
Tenant A frontend or curl
         |
         v
Tenant A Asset Service (platform namespace)
         |
         v
GET tenant:tenant_a:assets:list  [Dragonfly]
         |
         +-- Cache HIT  --> Return cached assets
         |
         +-- Cache MISS --> Query tenant_a schema in CNPG PostgreSQL
                            --> Store result in Dragonfly with 60s TTL
                            --> Return assets
```

### Step 1: Port-forward Tenant A's Asset Service

In a separate Ubuntu terminal:

```bash
kubectl port-forward -n platform svc/asset-service 5001:5001
```

Keep the port-forward running.

### Step 2: Request the asset list

```bash
curl -s http://localhost:5001/api/data
```

**Actual response** from our test:

```json
[
  {
    "id": 1,
    "name": "tenant-a-server-01",
    "type": "VM",
    "createdAt": "2026-11-14T06:28:22.692Z",
    "incidents": [
      {
        "id": 1,
        "assetId": "1",
        "issue": "CPU usage v.high",
        "createdAt": "2026-11-14T06:28:37.113Z"
      }
    ]
  }
]
```

The API returned Tenant A's data successfully.

### Step 3: Connect to Dragonfly as administrator

```bash
kubectl exec -it -n dragonfly deployment/dragonfly -- redis-cli
```

Inside `redis-cli`:

```redis
AUTH dragonfly_admin YOUR_ADMIN_PASSWORD
```

Use your actual password; **do not put passwords in documentation**.

Check the cached value:

```redis
GET tenant:tenant_a:assets:list
```

**Actual result** (formatted for readability):

```json
[{"id":1,"name":"tenant-a-server-01","type":"VM","createdAt":"2026-11-14T06:28:22.692Z"}]
```

This confirmed that Tenant A's asset list was present in Dragonfly. Notice the cached asset-list value is not necessarily identical to the API response, which can include incident information.

### Step 4: Check the TTL

```redis
TTL tenant:tenant_a:assets:list
```

One check returned:

```text
(integer) -2
```

**Meaning:** The key no longer existed, likely because its 60-second TTL expired.

We then requested the asset list again:

```bash
curl -s http://localhost:5001/api/data > /dev/null
```

Immediately afterward, the TTL returned:

```text
(integer) 53
```

**Meaning:** A new cached entry existed with 53 seconds left until expiration.

### Step 5: Repeat the request within the TTL

```bash
curl -s http://localhost:5001/api/data > /dev/null
```

Check the TTL again:

```redis
TTL tenant:tenant_a:assets:list
```

**Actual result:**

```text
(integer) 9
```

The TTL had decreased from **53 to 9** instead of being reset to 60.

### Test 1 conclusion

- **Confirmed:** Tenant A's data was stored in Dragonfly.
- **Confirmed:** The 60-second TTL expired cached entries as expected.
- **Observed:** The TTL continued decreasing between repeated API requests, which is **consistent with cache reuse**.
- **Not conclusively proven:** That the second API response was served from Dragonfly rather than PostgreSQL. To prove a true cache HIT, instrument the backend with `CACHE HIT` / `CACHE MISS` logging or metrics.

---

## Test 2 — Cache Invalidation After Asset Update

### Objective

When an asset is updated in PostgreSQL, the application's caching logic should invalidate stale cached asset-list data. Subsequent reads should retrieve and cache the updated data.

### Expected flow

```text
Tenant A updates an asset through its frontend
         |
         v
Tenant A Asset Service updates PostgreSQL (tenant_a schema)
         |
         v
Asset Service invalidates relevant Dragonfly cache key(s)
         |
         v
Next asset-list request queries fresh data and repopulates cache
```

### Step 1: Open Tenant A's frontend

In a separate Ubuntu terminal:

```bash
kubectl port-forward -n platform svc/frontend 8080:80
```

Open in a browser:

```text
http://localhost:8080
```

### Step 2: Ensure the cache key exists before updating

Use the asset-list API to populate the cache:

```bash
curl -s http://localhost:5001/api/data > /dev/null
```

Inside Dragonfly CLI authenticated as `dragonfly_admin`:

```redis
EXISTS tenant:tenant_a:assets:list
```

**Actual result:**

```text
(integer) 1
```

**Meaning:** The asset-list cache key existed.

### Step 3: Update an asset in the frontend

We changed the asset name:

```text
Before: tenant-a-server-01
After:  tenant-a-server-01-updated
```

The update was saved through Tenant A's frontend.

### Step 4: Check the cache after the update

```redis
EXISTS tenant:tenant_a:assets:list
```

**Actual result:**

```text
(integer) 1
```

**Meaning:** The key existed when we checked. This **does not, by itself, show an invalidation failure**: the frontend may have automatically refreshed the asset list and caused the key to be recreated immediately. Also, TTL expiry can affect results if checks aren't performed promptly.

### Step 5: Inspect the actual cached value

```redis
GET tenant:tenant_a:assets:list
```

**Actual result** (formatted for readability):

```json
[
  {
    "id": 1,
    "name": "tenant-a-server-01-updated",
    "type": "VM",
    "createdAt": "2026-11-14T06:28:22.692Z"
  }
]
```

**Meaning:** Dragonfly contained the **new** asset name rather than the stale value.

### Test 2 conclusion

- **Confirmed:** The application update resulted in the new asset name being present in Dragonfly.
- **Confirmed:** We did not observe the old asset name remaining in the cached value during our check.
- **Strongly supported:** Cache invalidation and subsequent refresh were functioning in this Minikube PoC.
- **Not conclusively proven:** That the old key was deleted *before* the new value was cached. For conclusive proof, instrument the backend invalidation path or update the asset through an API client without an automatic frontend refresh, then inspect the key immediately.

---

## Quick reference: Dragonfly CLI commands

Authenticate as the administrator after entering `redis-cli`:

```redis
AUTH dragonfly_admin YOUR_ADMIN_PASSWORD
```

| Command | Purpose |
|---|---|
| `GET tenant:tenant_a:assets:list` | Display cached asset-list data |
| `TTL tenant:tenant_a:assets:list` | Show seconds until the key expires |
| `EXISTS tenant:tenant_a:assets:list` | Check whether the key currently exists |
| `SCAN 0 MATCH tenant:tenant_a:*` | List matching Tenant A cache keys |

### TTL meanings

| TTL result | Meaning |
|---|---|
| Positive number, e.g. `53` | Key exists and has 53 seconds left |
| `-2` | Key does not exist, including after expiration |
| `-1` | Key exists but has no expiration |

---

## Overall test summary

| Check | What we observed | Conclusion |
|---|---|---|
| API retrieval | `/api/data` returned Tenant A's assets | Passed |
| Cache populated | `GET` showed Tenant A's asset list | Passed |
| TTL configured | TTL showed `53`, then later `-2` on expiry | Passed |
| Repeat request | TTL decreased from `53` to `9` | Consistent with cache HIT; not definitive |
| Asset update | Changed `tenant-a-server-01` to `tenant-a-server-01-updated` | Passed |
| Cache content after update | `GET` showed updated name | Passed functional freshness check |
| Exact invalidation sequence | `EXISTS` was `1` after update | Cannot prove deletion occurred before refresh |

**Final takeaway:** For our Minikube proof of concept, both tests produced the expected functional behavior. To verify the internal cache decision path beyond doubt, add temporary cache HIT/MISS and invalidation logging in the backend. The source of truth remains PostgreSQL; Dragonfly holds temporary tenant-scoped cached data.

**Scope note:** These tests used Tenant A's Asset Service. Tenant B's Dragonfly cache creation and 60-second TTL were separately verified, and tenant ACL isolation had already been tested.
