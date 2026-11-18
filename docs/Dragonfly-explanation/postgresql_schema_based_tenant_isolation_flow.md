# PostgreSQL Schema-Based Tenant Isolation — Complete Implementation Flow

## 1. What we wanted to achieve

We wanted to run **one shared PostgreSQL cluster** for our multi-tenant SaaS application, but keep Tenant A's data separate from Tenant B's data.

Our application has two backend services:

- **Asset Service** — stores and retrieves assets.
- **Incident Service** — stores and retrieves incidents.

Both services should use the same PostgreSQL database infrastructure, but each tenant must access **only its own data**.

We implemented this first on **Minikube** using **CloudNativePG (CNPG)**, before adding Dragonfly caching.

## 2. Overall architecture

```text
                         One Minikube Kubernetes cluster

          Tenant A (platform namespace)       Tenant B (tenant-b namespace)
          ----------------------------       -----------------------------
          Frontend A                           Frontend B
              |                                    |
       +------+-------+                     +------+-------+
       |              |                     |              |
    Asset A       Incident A             Asset B       Incident B
       |              |                     |              |
       +------+-------+                     +------+-------+
              |                                    |
         PG_SCHEMA=tenant_a                  PG_SCHEMA=tenant_b
         PG_USER=tenant_a_user               PG_USER=tenant_b_user
              |                                    |
              +----------------+-------------------+
                               |
                    CNPG PostgreSQL Service
                     platform-postgres-rw
                               |
                    Shared CNPG PostgreSQL
                      Cluster: platform-postgres
                      Database: platform_db
                               |
                    +----------+----------+
                    |                     |
               Schema tenant_a       Schema tenant_b
               assets, incidents     assets, incidents
```

**Important:** We did **not** create a separate PostgreSQL cluster or database for every tenant. We created **separate schemas within the same database**.

## 3. Install and run one shared CNPG PostgreSQL cluster

We used the **CloudNativePG (CNPG) operator** in Minikube and created a single PostgreSQL cluster named:

```text
platform-postgres
```

Its important configuration was:

| Setting | Our Minikube configuration |
|---|---|
| Kubernetes namespace | `platform` |
| CNPG cluster | `platform-postgres` |
| PostgreSQL database | `platform_db` |
| Initial database role | `app` |
| PostgreSQL instances | 1 (PoC) |
| Persistent volume claim | 5 GiB |
| Read/write Service | `platform-postgres-rw` |

We had previously used separate practice clusters (`asset-postgres` and `incident-postgres`), but moved to **one shared `platform-postgres` cluster**.

For applications inside the `platform` namespace, the hostname is:

```text
platform-postgres-rw
```

From another namespace, such as `tenant-b`, use its fully qualified Kubernetes DNS name:

```text
platform-postgres-rw.platform.svc.cluster.local
```

**Why?** Kubernetes Services are discoverable across namespaces using their service DNS names. The short name normally resolves within the caller's namespace.

## 4. Create a separate PostgreSQL schema for each tenant

Within our **one `platform_db` database**, we created:

```sql
CREATE SCHEMA tenant_a;
CREATE SCHEMA tenant_b;
```

A schema is a **logical container** for database objects such as tables and sequences.

Our database organization became:

```text
platform_db
├── tenant_a
│   ├── assets
│   └── incidents
└── tenant_b
    ├── assets
    └── incidents
```

**Why separate schemas?** Both tenants can have tables named `assets` and `incidents`, but the tables and their records are separate.

For example:

```sql
SELECT * FROM tenant_a.assets;
SELECT * FROM tenant_b.assets;
```

Those queries target different tables, although they run in the same PostgreSQL database.

## 5. Why we added `PG_SCHEMA` to both backend services

Our original application code used PostgreSQL without specifying a tenant schema for each query. We updated the backend code to read a `PG_SCHEMA` environment variable.

The relevant behavior is represented by:

```javascript
const PG_SCHEMA = process.env.PG_SCHEMA || "public";

const pool = new Pool({
  // Existing PostgreSQL connection settings, such as host, user and password
  options: `-c search_path=${PG_SCHEMA}`,
});
```

**What does `search_path` do?** It tells PostgreSQL where to look for unqualified table names.

For Tenant A:

```text
PG_SCHEMA=tenant_a
```

An application query such as:

```sql
SELECT * FROM assets;
```

resolves to the `assets` table in the tenant's selected schema (provided that the table exists and the user's permissions allow access).

For Tenant B:

```text
PG_SCHEMA=tenant_b
```

The same SQL in the same source code targets Tenant B's schema.

**Important:** `PG_SCHEMA` selects the schema; **by itself, it is not a security boundary**. PostgreSQL user permissions provide the real access restriction.

## 6. Why we created different PostgreSQL users

We created separate database roles:

- `tenant_a_user` for Tenant A.
- `tenant_b_user` for Tenant B.

Each role has its own password and is granted access to its own schema and tables.

Conceptually, the permission setup is:

```sql
GRANT USAGE ON SCHEMA tenant_a TO tenant_a_user;
GRANT USAGE ON SCHEMA tenant_b TO tenant_b_user;
```

We also configured ownership and/or appropriate permissions on each tenant's tables and sequences, rather than granting shared access to all tenants.

We removed the previous common `app` role's access to the tenant schemas and tested that tenant users could not access one another's tables.

**Example:** When connected as `tenant_a_user`:

```sql
SELECT * FROM tenant_a.assets;  -- Allowed
SELECT * FROM tenant_b.assets;  -- Permission denied
```

The same separation applies in the opposite direction for `tenant_b_user`.

### Two layers of isolation

| Configuration | Purpose |
|---|---|
| `PG_SCHEMA=tenant_a` | Routes Tenant A's normal SQL queries to `tenant_a` tables |
| `PG_USER=tenant_a_user` | Restricts what PostgreSQL objects Tenant A can access |

We need **both**: selecting a schema makes the application use the correct tables, and database permissions prevent cross-tenant access.

## 7. Why Kubernetes Secrets were required

Each tenant's Asset and Incident Service Pods need credentials to authenticate to PostgreSQL.

We created these Kubernetes Secrets:

| Tenant | Namespace | PostgreSQL Secret |
|---|---|---|
| Tenant A | `platform` | `tenant-a-db-credentials` |
| Tenant B | `tenant-b` | `tenant-b-db-credentials` |

Each Secret contains the database credentials used by that tenant, including the username and password.

**Why?** The PostgreSQL server knows which users are allowed, but application Pods still need the **correct username and password** to log in. Kubernetes Secrets provide those credentials without putting literal passwords in application code.

We reused each tenant's Secret for both of that tenant's backend services.

**Important:** Kubernetes Secrets belong to a namespace. A Pod normally references Secrets in its own namespace. That's why Tenant A and Tenant B each received a separate Secret.

## 8. How Helm passes PostgreSQL configuration to the Pods

We updated the Helm chart templates for **both Asset Service and Incident Service** to support tenant-specific PostgreSQL settings, including:

- The database hostname.
- The database name.
- The schema (`PG_SCHEMA`).
- The PostgreSQL user (`PG_USER`).
- A Kubernetes Secret reference for the password.
- A toggle to use the shared external PostgreSQL cluster instead of deploying a database per service.

The relevant tenant-specific Helm overrides we actually used for **Tenant A's Asset Service** were:

```yaml
image:
  repository: asset-service
  tag: pg-schema-v1
  pullPolicy: Never

postgres:
  enabled: false
  externalHost: platform-postgres-rw
  database: platform_db
  schema: tenant_a
  user: tenant_a_user
  createSchema: false
  auth:
    existingSecret: tenant-a-db-credentials
```

For **Tenant B's Asset Service**, the overrides were:

```yaml
image:
  repository: asset-service
  tag: pg-schema-v1
  pullPolicy: Never

postgres:
  enabled: false
  externalHost: platform-postgres-rw.platform.svc.cluster.local
  database: platform_db
  schema: tenant_b
  user: tenant_b_user
  createSchema: false
  auth:
    existingSecret: tenant-b-db-credentials
```

The Incident Service uses its own chart and Docker image, but follows the same database connection pattern for each tenant.

**Why `postgres.enabled: false`?** In our charts, this prevents deploying an additional PostgreSQL instance alongside each service. Both services instead connect to the **already running shared CNPG cluster** using `postgres.externalHost`.

**Why `createSchema: false`?** We handled tenant schema creation and permissions separately instead of letting every application Pod create schemas automatically.

## 9. Why each tenant has separate application Pods

We reused the **same application source code and the same Helm charts**, but deployed separate releases into each tenant's namespace.

Our Minikube PoC currently has:

- Tenant A's Frontend, Asset Service and Incident Service in `platform`.
- Tenant B's Frontend, Asset Service and Incident Service in `tenant-b`.

Each application instance is configured with its own environment variables and credentials.

**Example:** The same Asset Service Docker image can serve either tenant:

```text
Asset Pod A -> PG_SCHEMA=tenant_a, PG_USER=tenant_a_user
Asset Pod B -> PG_SCHEMA=tenant_b, PG_USER=tenant_b_user
```

This is why we don't need to maintain different application source code or Helm charts for every tenant.

**Note:** Tenant A was initially left in the `platform` namespace for the PoC. We planned to move toward tenant-specific namespaces for all tenants during the later onboarding/GitOps stage.

## 10. How an actual request works

### Example: Tenant A opens its asset list

1. The user opens **Tenant A's frontend**.
2. The frontend sends a request to **Tenant A's Asset Service Pod**.
3. Asset Service connects to `platform-postgres-rw` using **`tenant_a_user`** and the password supplied by the Kubernetes Secret.
4. Its connection has `PG_SCHEMA=tenant_a`, which sets the PostgreSQL `search_path` to Tenant A's schema.
5. Asset Service reads **`tenant_a.assets`** using normal SQL.
6. PostgreSQL returns **only Tenant A's rows**, because the query targets its schema and the user has tenant-specific database permissions.
7. Asset Service sends the response back to Tenant A's frontend.

### What happens for Tenant B?

The application flow is the same, but it uses:

```text
PostgreSQL host: platform-postgres-rw.platform.svc.cluster.local
Database:        platform_db
PG_SCHEMA:       tenant_b
PG_USER:         tenant_b_user
Secret:          tenant-b-db-credentials
```

That leads to `tenant_b` tables, not Tenant A's tables.

## 11. How we tested that tenant isolation works

We performed two kinds of tests.

### Application-level test

We opened both tenant frontends using separate local port-forwards. The applications showed **different asset and incident data**:

- Tenant A showed its own asset (for example `tenant-a-server-01`) and its incident.
- Tenant B showed its own assets (for example `tenant-b-Server-01` and `tenant-b-server-02`) and their incidents.

This showed the application instances were querying different schemas.

### PostgreSQL permission test

We tested the actual roles in PostgreSQL.

For Tenant A:

```sql
SET ROLE tenant_a_user;
SELECT * FROM tenant_a.assets;   -- Succeeded
SELECT * FROM tenant_b.assets;   -- Permission denied
```

We also tested the opposite direction for Tenant B. The cross-tenant permission checks failed as intended. We checked schema permissions/ownership and confirmed the tenant roles were not members of one another.

**Why is this second test important?** Merely seeing different frontend data is not sufficient security proof. The PostgreSQL authorization test verifies that each tenant user is restricted even if someone tries to query the other tenant's tables explicitly.

## 12. What we changed in the application images

To support schema-based separation, we modified the Asset Service and Incident Service backend code and Helm charts, then built Minikube images:

```text
asset-service:pg-schema-v1
incident-service:pg-schema-v1
```

We deployed these images in both tenants with different Helm settings.

Later, when we implemented Dragonfly caching, we created newer images:

```text
asset-service:dragonfly-v1
incident-service:dragonfly-v1
```

Those newer images retain the PostgreSQL tenant-schema behavior while adding Dragonfly caching.

## 13. What about the future shell script + GitOps onboarding?

Right now, we created the tenant schemas, database users, credential Secrets and Helm configuration manually to understand and test the setup.

During the later GitOps onboarding stage, our intended workflow is:

```text
./onboard-tenant.sh tenant-c
            |
            v
Register Tenant C in GitOps configuration
            |
            v
Provision tenant_c PostgreSQL schema
            |
            v
Create tenant_c_user and restrict permissions
            |
            v
Generate/store database password securely
            |
            v
Provide tenant-scoped Kubernetes Secret
            |
            v
Argo CD deploys Tenant C's app Pods using Helm
            |
            v
Pods connect to shared CNPG PostgreSQL as tenant_c_user
```

**Important:** Argo CD applies Kubernetes resources, but database-level SQL provisioning needs an explicit mechanism such as a controlled Kubernetes Job or provisioning workflow. We will design that automation when we reach GitOps onboarding. We must not commit plaintext passwords to Git.

## 14. Five things to remember

1. **One CNPG cluster:** We use `platform-postgres` for both tenants.
2. **One database:** Both tenants share `platform_db`.
3. **Separate schemas:** `tenant_a` and `tenant_b` hold separate tables/data.
4. **Separate PostgreSQL users and Kubernetes Secrets:** `tenant_a_user` and `tenant_b_user` authenticate separately, with database permissions restricting cross-tenant access.
5. **Same source code, different Helm values:** Each tenant's Asset and Incident Service Pods receive different `PG_SCHEMA`, `PG_USER` and credential settings.

### Final summary

**`PG_SCHEMA` tells the application where its tables are. `PG_USER` and PostgreSQL permissions determine which tables it is allowed to access. Kubernetes Secrets provide the login credentials, and Helm injects the relevant configuration into each tenant's application Pods.**

Together, this gives us one shared PostgreSQL database infrastructure with isolated tenant data.

---

*This document reconstructs the PostgreSQL schema-isolation walkthrough from our implementation and subsequent explanations. It is a separate guide from the Dragonfly caching document; it is not a verbatim copy of the earlier conversation.*
