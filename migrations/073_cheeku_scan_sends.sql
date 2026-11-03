-- Cheeku only: the bill goes to the grahak when the QR of ANY slip is scanned (not only a slip sent on),
-- on WhatsApp (the picture) and by SMS (a short line with a link to the same picture).
--
-- forward_sends keeps one row per slip as before; it now also says what kind of slip it is and where
-- its SMS stands (its own status, tries and retry clock, so one channel failing never holds the other).
-- bill_links maps the short code in the SMS link to the slip: read by the public /b/:code page, which
-- has no shop yet, so it is not shop-isolated (it holds only random codes and ids, never the bill).

ALTER TABLE forward_sends
  ADD COLUMN kind          text NOT NULL DEFAULT 'ladan' CHECK (kind IN ('ladan', 'slip')),
  ADD COLUMN sms_status    text NOT NULL DEFAULT 'waiting' CHECK (sms_status IN ('none', 'waiting', 'sending', 'sent', 'failed')),
  ADD COLUMN sms_force     boolean NOT NULL DEFAULT false,
  ADD COLUMN sms_tries     integer NOT NULL DEFAULT 0,
  ADD COLUMN sms_error     text,
  ADD COLUMN sms_id        text,
  ADD COLUMN sms_retry_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN sms_sent_at   timestamptz;

-- Slips queued before SMS existed are not texted after the fact.
UPDATE forward_sends SET sms_status = 'none';

CREATE TABLE bill_links (
  code        text PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  bill_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, bill_id)
);

GRANT SELECT, INSERT ON bill_links TO mandipos_api;
