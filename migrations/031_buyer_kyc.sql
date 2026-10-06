-- A grahak's eKYC: Aadhaar through DigiLocker (ULIP), PAN if given, the fingers taken at the
-- counter. One row per grahak, replaced when the KYC is done again.
--
-- What is kept, and how:
-- * The Aadhaar number never is: UIDAI's XML carries it masked, and only the last four are
--   stored. The signed XML, its photo and the PAN record are AES-GCM sealed by the API
--   (KYC_DATA_KEY), so a database dump alone reads as noise.
-- * Fingers: which finger, the scanner's quality score and the device, never the biometric.
--   The RD service hands out a block only UIDAI can open; nothing here can rebuild a print.
-- * The consent the grahak gave, word for word, with when and from which terminal.
-- * source says whether this came from ULIP staging (test data, test OTP) or production.
CREATE TABLE buyer_kyc (
  buyer_id       uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  source         text NOT NULL CHECK (source IN ('ulip', 'ulip-staging')),
  aadhaar_last4  text NOT NULL CHECK (aadhaar_last4 ~ '^\d{4}$'),
  name           text NOT NULL,
  dob            text NOT NULL,
  gender         text NOT NULL,
  care_of        text NOT NULL DEFAULT '',
  address        text NOT NULL DEFAULT '',
  pincode        text NOT NULL DEFAULT '',
  photo_sealed   bytea,
  eaadhaar_sealed bytea NOT NULL,
  eaadhaar_issued_at text NOT NULL DEFAULT '',
  otp_mobile     text NOT NULL,
  pan_last4      text CHECK (pan_last4 ~ '^[0-9A-Z]{4}$'),
  pan_status     text NOT NULL DEFAULT 'none' CHECK (pan_status IN ('none', 'verified', 'failed')),
  pan_note       text NOT NULL DEFAULT '',
  pan_sealed     bytea,
  fingers        jsonb NOT NULL DEFAULT '[]',
  consent_text   text NOT NULL,
  consent_at     timestamptz NOT NULL,
  verified_by    uuid NOT NULL REFERENCES users(id),
  device_id      uuid NOT NULL REFERENCES devices(id),
  verified_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, buyer_id) REFERENCES buyers (shop_id, id)
);

ALTER TABLE buyer_kyc ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON buyer_kyc TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON buyer_kyc TO mandipos_api;
