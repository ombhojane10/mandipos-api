-- The old software's Company and Masters menus, on the website. Website only, like beejaks and
-- deposit slips: never synced to the terminals. (Products themselves stay the synced brands; a
-- rename or hide is pushed like a terminal's, so the machines pick it up.)

-- Company Master: what the shop's own details lacked.
ALTER TABLE shops
  ADD COLUMN licence_no     text NOT NULL DEFAULT '',
  ADD COLUMN company_code   text NOT NULL DEFAULT '',
  ADD COLUMN contact_person text NOT NULL DEFAULT '',
  ADD COLUMN email          text NOT NULL DEFAULT '';

-- Product Group Master ("Thompson", "Sonaka"); a product (brand) sits in at most one group.
CREATE TABLE product_groups (
  id          uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_groups_name ON product_groups (shop_id, upper(trim(name)));

CREATE TABLE brand_groups (
  brand_id    uuid PRIMARY KEY REFERENCES brands(id),
  shop_id     uuid NOT NULL REFERENCES shops(id),
  group_id    uuid NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE
);
CREATE INDEX brand_groups_group ON brand_groups (group_id);

-- Area Master. buyers.area and supplier_phones.area (062) hold the name itself; a rename here
-- rewrites it on those rows.
CREATE TABLE areas (
  id          uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  code        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX areas_name ON areas (shop_id, upper(trim(name)));

-- Store Master: the cold stores the shop keeps maal in.
CREATE TABLE stores (
  id              uuid PRIMARY KEY,
  shop_id         uuid NOT NULL REFERENCES shops(id),
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  address         text NOT NULL DEFAULT '',
  contact_person  text NOT NULL DEFAULT '',
  phone           text NOT NULL DEFAULT '',
  hidden          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stores_name ON stores (shop_id, upper(trim(name)));

-- General Ledger: the shop's own account heads beside the Day Book's built-in ones. A Day Book
-- line for a head is written as the nearest built-in category (kharcha / aur_aaya / aur_gaya)
-- with party_name = the head's name, so the app still reads it. Opening is on the head's own
-- side (debit for expense and asset, credit for income and liability).
CREATE TABLE ledger_heads (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  type           text NOT NULL CHECK (type IN ('expense', 'income', 'asset', 'liability')),
  opening_paise  bigint NOT NULL DEFAULT 0 CHECK (opening_paise >= 0),
  opening_on     date,
  hidden         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_heads_name ON ledger_heads (shop_id, upper(trim(name)));

GRANT SELECT, INSERT, UPDATE, DELETE ON product_groups, brand_groups, areas, stores, ledger_heads TO mandipos_api;
ALTER TABLE product_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON product_groups TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE brand_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON brand_groups TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE areas ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON areas TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON stores TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE ledger_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON ledger_heads TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
