-- Cheeku only: the bill that goes to the grahak on WhatsApp once the maal of a slip sent on is scanned.
--
-- The terminal that makes the slip uploads the picture of the party's slip with the grahak's
-- mobile (the server cannot draw it). From then on the server owns the send: a scan from ANY
-- device lands in pickups, and the first one sends the picture, retrying every few minutes until
-- WhatsApp takes it (it also waits for the shop's template to be approved and the bot to be on).
-- One row per slip; status says where it stands, so a failure is seen and can be sent again.
-- Server-only, not a sync table.

CREATE TABLE forward_sends (
  shop_id       uuid NOT NULL REFERENCES shops(id),
  bill_id       uuid NOT NULL,
  phone         text NOT NULL,
  image         bytea NOT NULL,
  params        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sending', 'sent', 'failed')),
  force         boolean NOT NULL DEFAULT false,      -- asked to go now, scanned or not (Dobara bhejein)
  tries         integer NOT NULL DEFAULT 0,
  error         text,
  wa_message_id text,
  retry_at      timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  PRIMARY KEY (shop_id, bill_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON forward_sends TO mandipos_api;
ALTER TABLE forward_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON forward_sends TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
