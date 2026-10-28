-- Angoor: after the labour scans a slip at the gaadi and hands over its boxes, the grahak gets a
-- WhatsApp — "maal de diya": the slip, the boxes just given, what is left, the time. One message
-- per slip per round of scans (the server waits a short quiet spell, so ten scans in a row are
-- one message), from the MandiPlus bot's number with a UTILITY template.
--
-- A notice row covers every scan on that slip received up to `upto`; the next round starts after
-- it. Rows are written before the send goes, so a restart never sends one twice.
CREATE TABLE pickup_notices (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  bill_id       uuid NOT NULL,
  upto          timestamptz NOT NULL,
  boxes         integer NOT NULL DEFAULT 0,
  phone         text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'sending' CHECK (status IN ('baseline', 'skipped', 'sending', 'waiting', 'sent', 'failed')),
  tries         integer NOT NULL DEFAULT 0,
  retry_at      timestamptz,
  params        text[] NOT NULL DEFAULT '{}',
  wa_message_id text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pickup_notices_bill ON pickup_notices (shop_id, bill_id, upto DESC);
CREATE INDEX pickup_notices_waiting ON pickup_notices (retry_at) WHERE status = 'waiting';

GRANT SELECT, INSERT, UPDATE ON pickup_notices TO mandipos_api;

-- Scans made before this existed are not news: every slip already scanned starts covered.
INSERT INTO pickup_notices (id, shop_id, bill_id, upto, status)
SELECT gen_random_uuid(), shop_id, bill_id, MAX(received_at), 'baseline' FROM pickups GROUP BY shop_id, bill_id;
