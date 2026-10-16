-- Udhaar sent to one grahak on WhatsApp when the owner asks (the portal's "WhatsApp bhejein",
-- or Bolo), through the MandiPlus bot's number and the approved udhaar_baaki_reminder_v1
-- template. Logged before it goes: a second press within 10 minutes is refused, and the khata
-- shows when the grahak was last sent their udhaar.
CREATE TABLE whatsapp_sends (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  buyer_id      uuid NOT NULL,
  phone         text NOT NULL,
  due_paise     bigint NOT NULL CHECK (due_paise > 0),
  sent_by       text NOT NULL,
  status        text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  wa_message_id text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_sends_buyer ON whatsapp_sends (shop_id, buyer_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON whatsapp_sends TO mandipos_api;
