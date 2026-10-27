-- Angoor: the beejak (supplier parchi) a shop makes for a gaadi, kept so it can be opened, printed
-- and sent again. The boxes per quality are what sold off the gaadi when it was made; the bhav is
-- the shop's own (never the real sale rates); the kharcha heads follow the shop's old "Sale
-- Proceed" software — commission, association, loading, labour, bardana, bhada, dak, bank,
-- crate, store, custom, other. One beejak a gaadi: making it again updates it, number kept.
-- Website only: not part of the terminals' sync.

CREATE TABLE beejaks (
  id              uuid PRIMARY KEY,
  shop_id         uuid NOT NULL REFERENCES shops(id),
  truck_id        uuid NOT NULL,
  beejak_no       integer NOT NULL CHECK (beejak_no > 0),
  party           text NOT NULL DEFAULT '',
  gaadi           text NOT NULL DEFAULT '',
  day             date NOT NULL,
  lines           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(lines) = 'array'),
  expenses        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(expenses) = 'array'),
  boxes           integer NOT NULL DEFAULT 0,
  gross_paise     bigint NOT NULL DEFAULT 0,
  expenses_paise  bigint NOT NULL DEFAULT 0,
  net_paise       bigint NOT NULL DEFAULT 0,
  made_by         text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, truck_id),
  UNIQUE (shop_id, beejak_no)
);
CREATE INDEX beejaks_recent ON beejaks (shop_id, day DESC);

GRANT SELECT, INSERT, UPDATE ON beejaks TO mandipos_api;
ALTER TABLE beejaks ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON beejaks TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
