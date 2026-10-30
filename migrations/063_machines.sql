-- MandiPlus hands out POS machines (Pine P5s and the like). The register says which machine —
-- by its serial number — is with whom: the shop, the person and their mobile, since when, and
-- which app login runs on it (a devices row, so its last-seen time and app version show beside
-- it). Every hand-over, return and change is kept in machine_events, so who had a machine on
-- any day can be answered later.
CREATE TABLE machines (
  id          uuid PRIMARY KEY,
  serial      text NOT NULL,
  model       text NOT NULL DEFAULT '',
  tid         text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'stock' CHECK (status IN ('stock', 'given', 'repair', 'lost')),
  shop_id     uuid REFERENCES shops(id),
  holder_name text NOT NULL DEFAULT '',
  holder_phone text NOT NULL DEFAULT '',
  given_on    date,
  device_id   uuid REFERENCES devices(id),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX machines_serial ON machines (upper(serial));
CREATE UNIQUE INDEX machines_device ON machines (device_id) WHERE device_id IS NOT NULL;

CREATE TABLE machine_events (
  id           uuid PRIMARY KEY,
  machine_id   uuid NOT NULL REFERENCES machines(id),
  action       text NOT NULL CHECK (action IN ('added', 'given', 'returned', 'repair', 'lost', 'linked', 'edited')),
  shop_id      uuid REFERENCES shops(id),
  holder_name  text NOT NULL DEFAULT '',
  holder_phone text NOT NULL DEFAULT '',
  on_day       date NOT NULL,
  note         text NOT NULL DEFAULT '',
  by_phone     text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX machine_events_machine ON machine_events (machine_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON machines, machine_events TO mandipos_api;
