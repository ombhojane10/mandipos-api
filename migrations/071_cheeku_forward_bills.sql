-- Cheeku only: the shop's own bill for a slip sent on (Aage bhejna), in the layout of a commission
-- agent's bill: each quality's boxes at a rate, less bhada, mazdoori and commission, to a net.
--
-- It is the shop's own working copy: editing it never touches the slip, its QR or the books. A
-- row exists only once the bill has been edited; until then the bill is the slip as written and
-- nil charges. rates holds the shop's own rate per quality ({ "<brand id>": paise }). Server-only,
-- not a sync table: terminals read and write it through /v1/cheeku/forward-bills.

CREATE TABLE forward_bills (
  shop_id          uuid NOT NULL REFERENCES shops(id),
  bill_id          uuid NOT NULL,                    -- the slip (bills.id)
  rates            jsonb NOT NULL DEFAULT '{}'::jsonb,
  bhada_paise      bigint NOT NULL DEFAULT 0 CHECK (bhada_paise BETWEEN 0 AND 1000000000000),
  mazdoori_paise   bigint NOT NULL DEFAULT 0 CHECK (mazdoori_paise BETWEEN 0 AND 1000000000000),
  commission_paise bigint NOT NULL DEFAULT 0 CHECK (commission_paise BETWEEN 0 AND 1000000000000),
  updated_by       text NOT NULL DEFAULT '',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, bill_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON forward_bills TO mandipos_api;
ALTER TABLE forward_bills ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON forward_bills TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
