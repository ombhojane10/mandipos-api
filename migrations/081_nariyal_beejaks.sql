-- Nariyal: the beejak for a gaadi taken on Commission (trucks.deal = 'commission', 079). Made on
-- the app's Bikri page: dana sold off the gaadi per maal and grade, the bhav the shop writes, the
-- kharcha heads, and what the supplier is paid. One a gaadi; making it again updates it, number kept.
--
-- Its own table, apart from grapes' `beejaks`: no book, trial balance, creditors or report reads
-- it, so nariyal's accounts stay exactly as they were. Server only, not synced; reached through
-- /v1/nariyal/beejaks (src/nariyal/).

CREATE TABLE nariyal_beejaks (
  id              uuid PRIMARY KEY,
  shop_id         uuid NOT NULL REFERENCES shops(id),
  truck_id        uuid NOT NULL,
  beejak_no       integer NOT NULL CHECK (beejak_no > 0),
  party           text NOT NULL DEFAULT '',
  gaadi           text NOT NULL DEFAULT '',
  day             date NOT NULL,
  lines           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(lines) = 'array'),
  expenses        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(expenses) = 'array'),
  dana            integer NOT NULL DEFAULT 0,
  gross_paise     bigint NOT NULL DEFAULT 0,
  expenses_paise  bigint NOT NULL DEFAULT 0,
  net_paise       bigint NOT NULL DEFAULT 0,
  made_by         text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, truck_id),
  UNIQUE (shop_id, beejak_no)
);
CREATE INDEX nariyal_beejaks_recent ON nariyal_beejaks (shop_id, day DESC);

GRANT SELECT, INSERT, UPDATE ON nariyal_beejaks TO mandipos_api;
ALTER TABLE nariyal_beejaks ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON nariyal_beejaks TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
