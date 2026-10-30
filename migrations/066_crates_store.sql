-- The old software's Crate In / Crate Out and Store Entry, on the website. Website only, like
-- beejaks, deposit slips and the masters: never synced to the terminals.

-- Crate types ("PLASTIC CRATE") and what a crate is worth when it does not come back.
CREATE TABLE crate_types (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  deposit_paise  bigint NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  hidden         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crate_types_name ON crate_types (shop_id, upper(trim(name)));

-- Crates out to a party (a grahak or laddan party by buyer_id, or a supplier by name) and back in.
-- A party's balance is out − in. bill_id: the parchi they went with, when said.
CREATE TABLE crate_moves (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  day            date NOT NULL,
  dir            text NOT NULL CHECK (dir IN ('out', 'in')),
  buyer_id       uuid,
  party          text NOT NULL DEFAULT '',
  crate_type_id  uuid NOT NULL REFERENCES crate_types(id),
  qty            integer NOT NULL CHECK (qty > 0),
  bill_id        uuid,
  note           text NOT NULL DEFAULT '',
  created_by     text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id IS NOT NULL OR length(trim(party)) > 0)
);
CREATE INDEX crate_moves_day ON crate_moves (shop_id, day DESC);
CREATE INDEX crate_moves_buyer ON crate_moves (shop_id, buyer_id);

-- Store Entry: a gaadi's quality put into a cold store (Store Master) and taken out again. A move
-- removed is kept, struck out (voided_at), because of what it wrote on the gaadi (store_sync).
CREATE TABLE store_moves (
  id          uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  day         date NOT NULL,
  dir         text NOT NULL CHECK (dir IN ('in', 'out')),
  store_id    uuid NOT NULL REFERENCES stores(id),
  truck_id    uuid NOT NULL,
  brand_id    uuid NOT NULL,
  boxes       integer NOT NULL CHECK (boxes > 0),
  kg          numeric(12, 2) NOT NULL DEFAULT 0 CHECK (kg >= 0),
  rent_paise  bigint NOT NULL DEFAULT 0 CHECK (rent_paise >= 0),
  note        text NOT NULL DEFAULT '',
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz
);
CREATE INDEX store_moves_day ON store_moves (shop_id, day DESC);
CREATE INDEX store_moves_lot ON store_moves (shop_id, truck_id, brand_id);

-- The synced rows the store register wrote so the gaadi's baaki leaves out what is in a store:
-- 'store' = a spoilage row of kind 'store' (boxes off the gaadi, as the app's Store button writes),
-- 'lot' = a truck_grades lot line (boxes back on the gaadi, as the app's addToTruck writes).
-- id is the synced row's own id. Per gaadi and quality, store − lot = boxes in stores now.
CREATE TABLE store_sync (
  id          uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  move_id     uuid NOT NULL REFERENCES store_moves(id),
  truck_id    uuid NOT NULL,
  brand_id    uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('store', 'lot')),
  qty         integer NOT NULL CHECK (qty > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_sync_lot ON store_sync (shop_id, truck_id, brand_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON crate_types, crate_moves, store_moves, store_sync TO mandipos_api;
ALTER TABLE crate_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON crate_types TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE crate_moves ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON crate_moves TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE store_moves ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON store_moves TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE store_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON store_sync TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
