-- eKYC through DigiLocker's own sign-in page (via Surepass): the grahak types their mobile
-- or Aadhaar and the OTP themselves. Same buyer_kyc row, two more sources: 'surepass' and
-- 'surepass-sandbox' (test data).
ALTER TABLE buyer_kyc DROP CONSTRAINT buyer_kyc_source_check;
ALTER TABLE buyer_kyc ADD CONSTRAINT buyer_kyc_source_check
  CHECK (source IN ('ulip', 'ulip-staging', 'surepass', 'surepass-sandbox'));

-- DigiLocker's sign-in is the OTP; there may be no separate number we sent one to.
ALTER TABLE buyer_kyc ALTER COLUMN otp_mobile SET DEFAULT '';
