-- A WhatsApp every morning to each grahak who owes the shop, with their total udhaar.
--
-- Off until the shop's admin turns it on (udhaar_alerts), and the server only sends when
-- UDHAAR_ALERTS=on with an approved template. Every message is logged against the customer and
-- the day before it goes, so a restart or a second instance can never send one twice.

ALTER TABLE shops ADD COLUMN udhaar_alerts boolean NOT NULL DEFAULT false;

CREATE TABLE udhaar_alerts (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  buyer_id      uuid NOT NULL,
  alert_date    date NOT NULL,
  phone         text NOT NULL,
  due_paise     bigint NOT NULL CHECK (due_paise > 0),
  status        text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  wa_message_id text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, buyer_id, alert_date)
);

GRANT SELECT, INSERT, UPDATE ON udhaar_alerts TO mandipos_api;
