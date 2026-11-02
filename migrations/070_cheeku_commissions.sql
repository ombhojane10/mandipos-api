-- Cheeku only: the shop's commission on each party's sales, per party.
--
-- Grapes keep their one changeable % (remembered per device). A cheeku shop sets each supplier's
-- own % (Ravi 5%, Manat 7.5%); the row with supplier_key '' is the shop's default for everyone
-- else (6% until set). The beejak and the Commission bikri page start from the party's rate, and
-- saving a beejak at another % remembers it for that party. Server-only: not a sync table, so
-- terminals read it through /v1/cheeku/commissions and nothing changes for other shops.

CREATE TABLE cheeku_commissions (
  shop_id       uuid NOT NULL REFERENCES shops(id),
  supplier_key  text NOT NULL,              -- nameKey(supplier); '' = the shop's default
  name          text NOT NULL DEFAULT '',   -- the supplier as last written, for display
  bps           integer NOT NULL CHECK (bps BETWEEN 0 AND 5000),
  updated_by    text NOT NULL DEFAULT '',   -- who set it: the website's phone, or the app's name
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, supplier_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON cheeku_commissions TO mandipos_api;
ALTER TABLE cheeku_commissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON cheeku_commissions TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
