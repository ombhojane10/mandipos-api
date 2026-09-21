-- Mandi POS schema.
-- Money is bigint paise, quantities are integer nags. Rows written by a terminal
-- carry the device id and two clocks: created_at (device) and received_at (server).

-- ---------------------------------------------------------------- people & access

CREATE TABLE users (
  id          uuid PRIMARY KEY,
  phone       text NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  name        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shops (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  mandi       text NOT NULL DEFAULT '',
  shop_no     text NOT NULL DEFAULT '',
  gstin       text NOT NULL DEFAULT '',
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop_members (
  shop_id     uuid NOT NULL REFERENCES shops(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner', 'manager', 'munim')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, user_id)
);
CREATE INDEX shop_members_user ON shop_members (user_id);

-- A terminal or phone. `code` (A1, A2 …) prefixes the device's own bill series.
CREATE TABLE devices (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  shop_id       uuid REFERENCES shops(id),
  code          text CHECK (code ~ '^[A-Z][0-9]$'),
  label         text NOT NULL DEFAULT '',
  platform      text NOT NULL DEFAULT '',
  app_version   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  UNIQUE (shop_id, code)
);

-- Refresh tokens, stored hashed and rotated on every use.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  device_id     uuid NOT NULL REFERENCES devices(id),
  refresh_hash  text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  replaced_by   uuid
);
CREATE INDEX sessions_device ON sessions (device_id);

CREATE TABLE otp_codes (
  id                uuid PRIMARY KEY,
  phone             text NOT NULL,
  provider_session  text,
  code_hash         text,
  attempts          int NOT NULL DEFAULT 0,
  expires_at        timestamptz NOT NULL,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_phone ON otp_codes (phone, created_at DESC);

-- ---------------------------------------------------------------- sync feed

-- Last sequence number handed out per shop. Advanced under a per-shop
-- transaction lock so sequence numbers commit in order (no pull ever skips one).
CREATE TABLE shop_counters (
  shop_id   uuid PRIMARY KEY REFERENCES shops(id),
  last_seq  bigint NOT NULL DEFAULT 0
);

-- Every accepted row, in order. Devices pull from here with ?after=<seq>.
CREATE TABLE changes (
  shop_id      uuid NOT NULL REFERENCES shops(id),
  seq          bigint NOT NULL,
  table_name   text NOT NULL,
  row_id       uuid NOT NULL,
  row          jsonb NOT NULL,
  device_id    uuid NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, seq)
);

-- ---------------------------------------------------------------- masters (editable, last write wins)

CREATE TABLE buyers (
  id                  uuid PRIMARY KEY,
  shop_id             uuid NOT NULL REFERENCES shops(id),
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  phone               text NOT NULL DEFAULT '',
  kind                text NOT NULL DEFAULT '',
  credit_limit_paise  bigint NOT NULL DEFAULT 0 CHECK (credit_limit_paise >= 0),
  vehicle             text NOT NULL DEFAULT '',
  device_id           uuid NOT NULL REFERENCES devices(id),
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

-- A truck is the stock bucket: its own supplier, landed cost and grade mix.
CREATE TABLE trucks (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  number         text NOT NULL CHECK (length(trim(number)) > 0),
  supplier       text NOT NULL DEFAULT '',
  arrived_at     timestamptz NOT NULL,
  billed_qty     int NOT NULL CHECK (billed_qty > 0),
  free_qty       int NOT NULL DEFAULT 0 CHECK (free_qty >= 0),
  rate_paise     bigint NOT NULL CHECK (rate_paise >= 0),
  freight_paise  bigint NOT NULL DEFAULT 0 CHECK (freight_paise >= 0),
  labour_paise   bigint NOT NULL DEFAULT 0 CHECK (labour_paise >= 0),
  closed_at      timestamptz,
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

-- ---------------------------------------------------------------- facts (append-only)

CREATE TABLE truck_grades (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL,
  truck_id      uuid NOT NULL,
  grade         text NOT NULL CHECK (grade IN ('A', 'B', 'C')),
  received_qty  int NOT NULL CHECK (received_qty >= 0),
  device_id     uuid NOT NULL REFERENCES devices(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, truck_id) REFERENCES trucks (shop_id, id),
  UNIQUE (truck_id, grade)
);

CREATE TABLE bills (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  number         text NOT NULL CHECK (length(number) <= 16 AND number ~ '^[A-Za-z0-9/-]+$'),
  kind           text NOT NULL CHECK (kind IN ('kachchi', 'pakka')),
  buyer_id       uuid,
  buyer_name     text NOT NULL,
  business_date  date NOT NULL,
  pay_mode       text NOT NULL CHECK (pay_mode IN ('cash', 'upi', 'card', 'credit')),
  total_paise    bigint NOT NULL CHECK (total_paise >= 0),
  paid_paise     bigint NOT NULL CHECK (paid_paise >= 0 AND paid_paise <= total_paise),
  payment_ref    text NOT NULL DEFAULT '',
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, buyer_id) REFERENCES buyers (shop_id, id),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number)
);
CREATE INDEX bills_shop_date ON bills (shop_id, business_date);
CREATE INDEX bills_buyer ON bills (shop_id, buyer_id);

CREATE TABLE bill_lines (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL,
  bill_id      uuid NOT NULL,
  truck_id     uuid NOT NULL,
  grade        text NOT NULL CHECK (grade IN ('A', 'B', 'C')),
  qty          int NOT NULL CHECK (qty > 0),
  rate_paise   bigint NOT NULL CHECK (rate_paise >= 0),
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, bill_id) REFERENCES bills (shop_id, id),
  FOREIGN KEY (shop_id, truck_id) REFERENCES trucks (shop_id, id)
);
CREATE INDEX bill_lines_bill ON bill_lines (bill_id);
CREATE INDEX bill_lines_truck ON bill_lines (shop_id, truck_id);

-- The rate-free slip for the palledar / driver: which vehicle the goods left in.
CREATE TABLE lading_slips (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL,
  bill_id      uuid NOT NULL,
  vehicle      text NOT NULL DEFAULT '',
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, bill_id) REFERENCES bills (shop_id, id)
);

-- Vasooli: udhaar paid back, fully or in part.
CREATE TABLE collections (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL,
  buyer_id       uuid NOT NULL,
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  pay_mode       text NOT NULL CHECK (pay_mode IN ('cash', 'upi', 'card')),
  payment_ref    text NOT NULL DEFAULT '',
  business_date  date NOT NULL,
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, buyer_id) REFERENCES buyers (shop_id, id)
);
CREATE INDEX collections_buyer ON collections (shop_id, buyer_id);

CREATE TABLE spoilage (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL,
  truck_id       uuid NOT NULL,
  grade          text NOT NULL CHECK (grade IN ('A', 'B', 'C')),
  qty            int NOT NULL CHECK (qty > 0),
  business_date  date NOT NULL,
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, truck_id) REFERENCES trucks (shop_id, id)
);

CREATE TABLE day_closes (
  id                   uuid PRIMARY KEY,
  shop_id              uuid NOT NULL REFERENCES shops(id),
  business_date        date NOT NULL,
  expected_cash_paise  bigint NOT NULL,
  counted_cash_paise   bigint NOT NULL CHECK (counted_cash_paise >= 0),
  note                 text NOT NULL DEFAULT '',
  device_id            uuid NOT NULL REFERENCES devices(id),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX day_closes_shop_date ON day_closes (shop_id, business_date);

-- Raw Pine Labs results for reconciliation with the bank settlement.
CREATE TABLE terminal_payments (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  purpose        text NOT NULL CHECK (purpose IN ('bill', 'collection')),
  ref_id         uuid NOT NULL,
  pay_mode       text NOT NULL CHECK (pay_mode IN ('upi', 'card')),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  billing_ref    text NOT NULL,
  rrn            text NOT NULL DEFAULT '',
  approval_code  text NOT NULL DEFAULT '',
  response_code  int NOT NULL,
  response_msg   text NOT NULL DEFAULT '',
  raw            jsonb NOT NULL DEFAULT '{}',
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminal_payments_rrn ON terminal_payments (shop_id, rrn);
