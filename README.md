# mandipos-api

Backend for **Mandi POS**, the billing app on Pine Labs terminals (`../pinelabsapp`).
It does three things: phone-OTP login, shop registration, and offline sync of the
shop's books between terminals. Design and reasoning: [`../mandierp/BACKEND-PLAN.md`](../mandierp/BACKEND-PLAN.md).

## How it works

- **Terminals write locally first** and push their outbox to `POST /v1/sync/push`.
  Rows carry ids made on the device (UUIDv7), so a retried push is harmless
  (`ON CONFLICT (id) DO NOTHING`). Each row is applied in its own savepoint and gets its
  own result: `applied`, `skipped` (already had it) or `rejected` (invalid; never retried).
- **Every applied row is appended to `changes`** with the shop's next sequence number.
  Terminals pull with `GET /v1/sync/pull?after=<seq>` (pages of up to 500).
  A per-shop transaction lock makes sequence numbers commit in order, so no pull skips a row.
- **Facts are append-only** (bills, lines, collections, spoilage, day closes, terminal
  payments, lading slips). The runtime DB role has no UPDATE/DELETE on them — corrections
  are new rows. **Masters** (buyers, trucks) are last-write-wins on `updated_at`.
- **Shops are isolated by Postgres row-level security.** The API sets `app.shop_id` per
  transaction with `set_config(..., true)` (safe through Neon's pooler) and connects as
  `mandipos_api`, which is subject to the policies.
- **Bill numbers** are made on the device: `<device code>/<FY>/<serial>`, e.g.
  `A1/2627/000123` (kachchi series: `A1K/…`). Device codes (A1, A2 …) are assigned per shop
  at login; a re-login with the stored `deviceId` keeps the code, so the series continues.
- **No cron jobs, no DB in the health check, every list is paginated** — the three things
  that ran up the MandiPlus Neon bill.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | – | Render health check (no DB) |
| GET | `/readyz` | – | DB reachability |
| POST | `/v1/auth/otp` | – | `{phone}` → sends OTP (204) |
| POST | `/v1/auth/verify` | – | `{phone, code, deviceId?, device}` → tokens + `me` |
| POST | `/v1/auth/refresh` | – | `{refreshToken}` → rotated pair |
| POST | `/v1/auth/logout` | – | `{refreshToken}` |
| GET | `/v1/me` | bearer | user, device (code), shop |
| POST | `/v1/shops` | bearer | register the caller's shop; returns an access token with the shop |
| POST | `/v1/sync/push` | bearer + shop | `{items: [{table, row}]}` (≤ 200) |
| GET | `/v1/sync/pull` | bearer + shop | `?after=<seq>&limit=<≤500>` |

Access tokens last 15 minutes; refresh tokens 60 days, rotated on every use — reusing an
old one revokes every session on that device.

## Local development

Needs Postgres 16+ running locally and pnpm.

```bash
createdb mandipos_local
psql -d postgres -c "CREATE ROLE mandipos_api LOGIN PASSWORD 'local-only'"
cp .env.example .env
DATABASE_URL_DIRECT=postgres://localhost/mandipos_local pnpm migrate
pnpm dev            # http://localhost:3000 — OTPs are printed to the log
pnpm test           # e2e suite on a throwaway mandipos_test database
```

## Environments

| | Staging | Production |
|---|---|---|
| Render service | `mandipos-api-staging` (Starter) | `mandipos-api` (Standard) |
| Deploys | every push to `main` | manually, after staging |
| Neon | project `mandipos`, branch `staging` | project `mandipos`, branch `main` |
| Env group | `mandipos-staging` | `mandipos-production` |

Everything is in [`render.yaml`](render.yaml). `DATABASE_URL` is Neon's **pooled** URL for the
`mandipos_api` role; `DATABASE_URL_DIRECT` is the **direct** URL for the owner role and is
only used by `pnpm migrate` (Render's pre-deploy step).

Before the first migration on a Neon branch, create the runtime role **with SQL, as
`mandipos_owner`** — not in the Neon console or API, whose roles join `neon_superuser` and
bypass row-level security (which would silently disable shop isolation):

```sql
CREATE ROLE mandipos_api LOGIN PASSWORD '<strong random>' NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
```

Branches created afterwards inherit it. `002_security.sql` only grants to it.
