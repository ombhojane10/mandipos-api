-- The grahak card shows a face and two udhaar figures. Both used to live on one machine or
-- nowhere; now every terminal in the shop sees the same.
--
-- market_paise: what the grahak owes the rest of the mandi, as the shop knows it. Null =
-- not known (the card shows "—"), which is not the same as owing nothing.
ALTER TABLE buyers ADD COLUMN market_paise bigint CHECK (market_paise >= 0);

-- The grahak's photo, a small JPEG cut for the card. Kept out of `buyers` so a photo never
-- rides along in every sync of the grahak's row; terminals fetch it when the card is tapped.
CREATE TABLE buyer_photos (
  buyer_id    uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  jpeg        bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, buyer_id) REFERENCES buyers (shop_id, id)
);

ALTER TABLE buyer_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON buyer_photos TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON buyer_photos TO mandipos_api;
