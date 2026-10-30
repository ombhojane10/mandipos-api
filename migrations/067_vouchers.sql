-- The old software's remaining Transactions on the website: Journal Voucher, Credit Note and
-- Generate Invoices. Website only, like beejaks, deposit slips and crates: never synced. What a
-- voucher does to a grahak's khata is written as ordinary synced udhaar entries (so the app, the
-- Outstanding and every khata agree); voucher_udhaar says which entries a voucher wrote, so the
-- books post their other side to the voucher, not to the suspense.

-- Journal Voucher: an amount moved from one account to another without cash. Each side is a
-- grahak (buyer id), a supplier (by name, as the creditors' books fold names) or a ledger head
-- ('h:<id>' from the General Ledger master, or a built-in 'b:<category>'). dr = the account
-- debited (a grahak owes more / we owe the supplier less / an expense up), cr = the one credited.
-- A voucher removed is kept, struck out (voided_at), its number never reused.
CREATE TABLE journal_vouchers (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  no            integer NOT NULL CHECK (no > 0),
  day           date NOT NULL,
  dr_kind       text NOT NULL CHECK (dr_kind IN ('grahak', 'supplier', 'head')),
  dr_ref        text NOT NULL CHECK (length(trim(dr_ref)) > 0),
  dr_name       text NOT NULL DEFAULT '',
  cr_kind       text NOT NULL CHECK (cr_kind IN ('grahak', 'supplier', 'head')),
  cr_ref        text NOT NULL CHECK (length(trim(cr_ref)) > 0),
  cr_name       text NOT NULL DEFAULT '',
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  narration     text NOT NULL DEFAULT '',
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  CHECK (NOT (dr_kind = cr_kind AND dr_ref = cr_ref))
);
CREATE UNIQUE INDEX journal_vouchers_no ON journal_vouchers (shop_id, no);
CREATE INDEX journal_vouchers_day ON journal_vouchers (shop_id, day DESC);

-- Credit Note: what a grahak owes, reduced for a reason, optionally against one parchi. lines:
-- [{quality, grade, boxes, ratePaise, amountPaise}] as picked off that parchi; none = a flat amount.
CREATE TABLE credit_notes (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  no            integer NOT NULL CHECK (no > 0),
  day           date NOT NULL,
  buyer_id      uuid NOT NULL,
  bill_id       uuid,
  slip_no       integer,
  reason        text NOT NULL CHECK (reason IN ('rate', 'kharab', 'wapsi', 'discount', 'other')),
  lines         jsonb NOT NULL DEFAULT '[]',
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  note          text NOT NULL DEFAULT '',
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz
);
CREATE UNIQUE INDEX credit_notes_no ON credit_notes (shop_id, no);
CREATE INDEX credit_notes_day ON credit_notes (shop_id, day DESC);
CREATE INDEX credit_notes_buyer ON credit_notes (shop_id, buyer_id);

-- The synced udhaar entries a voucher wrote (its first posting, and each correction or reversal
-- since). udhaar_id is the udhaar_entries row's own id.
CREATE TABLE voucher_udhaar (
  udhaar_id     uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  kind          text NOT NULL CHECK (kind IN ('jv', 'cn')),
  voucher_id    uuid NOT NULL,
  buyer_id      uuid NOT NULL,
  day           date NOT NULL,
  amount_paise  bigint NOT NULL CHECK (amount_paise <> 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voucher_udhaar_voucher ON voucher_udhaar (shop_id, voucher_id);

-- Generate Invoices: a tax invoice from one or more parchis, numbered per financial year
-- (PREFIX/2026-27/0001). doc holds the invoice exactly as issued (seller, buyer, lines, charges,
-- totals), so a re-print is identical whatever changes later. A cancelled one keeps its number.
CREATE TABLE tax_invoices (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  fy            integer NOT NULL,
  seq           integer NOT NULL CHECK (seq > 0),
  number        text NOT NULL,
  day           date NOT NULL,
  buyer_id      uuid,
  buyer_name    text NOT NULL DEFAULT '',
  bill_ids      uuid[] NOT NULL,
  total_paise   bigint NOT NULL CHECK (total_paise >= 0),
  doc           jsonb NOT NULL,
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  void_reason   text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX tax_invoices_seq ON tax_invoices (shop_id, fy, seq);
CREATE INDEX tax_invoices_day ON tax_invoices (shop_id, day DESC);
CREATE INDEX tax_invoices_bills ON tax_invoices USING gin (bill_ids);

-- A grahak's GSTIN, for the invoice. Website only: never on a terminal.
CREATE TABLE buyer_gstin (
  buyer_id      uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  gstin         text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON journal_vouchers, credit_notes, voucher_udhaar, tax_invoices, buyer_gstin TO mandipos_api;
ALTER TABLE journal_vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON journal_vouchers TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON credit_notes TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE voucher_udhaar ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON voucher_udhaar TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE tax_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON tax_invoices TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE buyer_gstin ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON buyer_gstin TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
