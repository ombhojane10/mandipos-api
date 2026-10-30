-- Bank jama parchi (deposit slips): the cheques a shop gets from its grahak, and cash, taken to the
-- bank on one slip — kept as the shop's own record next to the paper slip the bank stamps. A slip
-- carries the account it goes into as it stood that day (holder, bank, number, depositor phone,
-- PAN), its cash by note, and its cheques. Each cheque is followed to cleared or bounced; one that
-- put money in a grahak's khata names the raseed (collection) it made, so a bounce can take it out.
-- Website only, like beejaks: never synced to the terminals.
CREATE TABLE deposit_slips (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  slip_no      integer NOT NULL,
  day          date NOT NULL,
  account      jsonb NOT NULL DEFAULT '{}',
  notes        jsonb NOT NULL DEFAULT '{}',
  cash_paise   bigint NOT NULL DEFAULT 0 CHECK (cash_paise >= 0),
  -- The cash's Day Book line (galla → bank, 'bank_jama'), when the slip wrote one.
  daybook_id   uuid,
  note         text NOT NULL DEFAULT '',
  created_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  voided_at    timestamptz,
  UNIQUE (shop_id, slip_no)
);
CREATE INDEX deposit_slips_recent ON deposit_slips (shop_id, day DESC);

CREATE TABLE deposit_cheques (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  slip_id        uuid NOT NULL REFERENCES deposit_slips(id),
  pos            integer NOT NULL DEFAULT 0,
  buyer_id       uuid,
  drawer         text NOT NULL DEFAULT '',
  bank           text NOT NULL DEFAULT '',
  branch         text NOT NULL DEFAULT '',
  city           text NOT NULL DEFAULT '',
  cheque_no      text NOT NULL DEFAULT '',
  cheque_date    date,
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  collection_id  uuid,
  made_raseed    boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cleared', 'bounced')),
  status_on      date,
  bounce_reason  text NOT NULL DEFAULT '',
  charges_paise  bigint NOT NULL DEFAULT 0 CHECK (charges_paise >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deposit_cheques_slip ON deposit_cheques (slip_id, pos);
CREATE INDEX deposit_cheques_buyer ON deposit_cheques (shop_id, buyer_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON deposit_slips, deposit_cheques TO mandipos_api;
ALTER TABLE deposit_slips ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON deposit_slips TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE deposit_cheques ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON deposit_cheques TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
