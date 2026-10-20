-- Bolo's "kal mujhe Afzal se paise lene ka yaad dilana": a reminder that goes out on WhatsApp
-- (template pos_yaad_dilao_v1) to the person who set it, at the time they said (9 a.m. when they
-- named a day but no time). Or, with action udhaar_whatsapp, the grahak's udhaar sent to the
-- grahak at that time. The server's own timer sends them; nothing here is synced to terminals.
CREATE TABLE reminders (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  created_by    text NOT NULL,
  to_phone      text NOT NULL CHECK (to_phone ~ '^[6-9][0-9]{9}$'),
  what          text NOT NULL CHECK (length(what) BETWEEN 1 AND 300),
  buyer_id      uuid,
  action        text NOT NULL DEFAULT 'note' CHECK (action IN ('note', 'udhaar_whatsapp')),
  due_at        timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  tries         integer NOT NULL DEFAULT 0,
  -- When a failed send (template still awaiting approval, a network error) is tried again.
  retry_at      timestamptz,
  wa_message_id text,
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due ON reminders ((COALESCE(retry_at, due_at))) WHERE status = 'pending';
CREATE INDEX reminders_shop ON reminders (shop_id, due_at);

GRANT SELECT, INSERT, UPDATE ON reminders TO mandipos_api;
