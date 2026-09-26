-- The rojmel: the third book, and the one that ends the evening cash tally.
--
-- "In the evening we find out straight away what our chart is… complete track of all expenses,
-- both going and coming." Money out is what the app never knew: mazdoori, bhada, the water
-- bill, and the loans that go out today and come back tomorrow ("someone comes and says give
-- me 50 thousand").
--
-- Only MANUAL entries live here. Cash sales and cash vasooli are read from bills and
-- collections when the day is drawn — never copied — so the two books cannot disagree, and
-- "the need to tally the cash is finished" holds: galla = opening + everything in - everything
-- out, always.
--
-- A master, not a fact: a human types these and a human mistypes them, so an entry can be
-- corrected or hidden.

CREATE TABLE daybook_entries (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  direction      text NOT NULL CHECK (direction IN ('in', 'out')),
  -- Where the money physically moved. Cash is what the galla feels; the rest is the bank.
  mode           text NOT NULL DEFAULT 'cash' CHECK (mode IN ('cash', 'upi', 'bank')),
  -- 'opening' is the one-time "galla mein abhi kitna hai" that starts the book.
  category       text NOT NULL DEFAULT '',
  -- Who the money went to or came from — the name on a loan, mostly.
  party_name     text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  business_date  date NOT NULL,
  hidden         boolean NOT NULL DEFAULT false,
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

CREATE INDEX daybook_entries_day ON daybook_entries (shop_id, business_date);

GRANT SELECT, INSERT, UPDATE ON daybook_entries TO mandipos_api;

ALTER TABLE daybook_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON daybook_entries TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
