-- A limit on how large a slip an accountant can write alone.
--
-- The admin sets it for the shop. An accountant's slip above it is not written: it goes to
-- the admin as a request, with what the slip would say. Approved, the accountant's terminal
-- writes the slip (so payment and printing stay at the counter) and marks the request used.
-- Admins' own slips never need a request.

ALTER TABLE shops ADD COLUMN slip_limit_paise bigint NOT NULL DEFAULT 0 CHECK (slip_limit_paise >= 0);

CREATE TABLE slip_requests (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  requested_by  uuid NOT NULL REFERENCES users(id),
  device_id     uuid NOT NULL REFERENCES devices(id),
  buyer_name    text NOT NULL DEFAULT '',
  total_paise   bigint NOT NULL CHECK (total_paise > 0),
  -- What the admin reads before deciding: gaadi, lines, payment split.
  detail        jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  bill_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX slip_requests_shop ON slip_requests (shop_id, status, created_at);

GRANT SELECT, INSERT, UPDATE ON slip_requests TO mandipos_api;
