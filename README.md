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

## Production

One environment, no staging.

| | |
|---|---|
| URL | https://mandipos-api.onrender.com |
| Render | service `mandipos-api` (`srv-daopc65g1s2s7383q00g`), Standard, Singapore, workspace `tea-d57p78u3jp1c73b3rn5g` |
| Neon | project `mandipos` (`proud-violet-83797826`), branch `main` (`br-young-sound-b33uyuqp`), always on, 7-day restore |
| Code | public repo `github.com/ombhojane10/mandipos-api`, branch `main` |
| Secrets | gitignored `.env.production` (and Render's env settings) |

Deploys are manual (auto-deploy is off): push to `main`, then deploy from the Render dashboard
(or ask Claude to trigger it). The start command runs `node scripts/migrate.mjs` before the
server, because the service was created through Render's API, which cannot set a pre-deploy
command; a failed migration stops the new instance and the old one keeps serving. Set the
health-check path to `/healthz` in the service settings.

`DATABASE_URL` is Neon's **pooled** URL for the `mandipos_api` role; `DATABASE_URL_DIRECT` is
the **direct** URL for the owner role, used only by the migration step.
`OTP_TEST_LOGINS` (fixed QA codes, no SMS) holds one demo login in production —
`9000000000:123456`, the number the Pine Labs UAT device signs in with. Anyone who knows the
pair is that shop, so it stays a demo shop and the variable is cleared before real shops are
onboarded; the owner's own number is refused there by the config schema.

After a migration adds a table, re-grant the **local** dev role — the migrations grant to
production's `mandipos_api` by name, so a local database's own role (e.g. `mandipos_app`) is
missed and every write to the new table fails with "not allowed for this shop" (Postgres 42501):

```bash
psql -d mandipos_local -c "SET my.role = 'mandipos_app';" -f scripts/local-role.sql
```

It copies the `shop_isolation` policy for the dev role only where the migrations created one.
Do not enable row-level security anywhere else: `devices` and `shop_members` are written before
a shop is known, and an isolation policy there blocks logging in.

Before the first migration on a new Neon project, create the runtime role **with SQL, as
`mandipos_owner`** — not in the Neon console or API, whose roles join `neon_superuser` and
bypass row-level security (which would silently disable shop isolation):

```sql
CREATE ROLE mandipos_api LOGIN PASSWORD '<strong random>' NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
```

`002_security.sql` only grants to it.
