-- DigiLocker eKYC through Sandbox.co.in as well as Surepass: two more buyer_kyc sources.
ALTER TABLE buyer_kyc DROP CONSTRAINT buyer_kyc_source_check;
ALTER TABLE buyer_kyc ADD CONSTRAINT buyer_kyc_source_check
  CHECK (source IN ('ulip', 'ulip-staging', 'surepass', 'surepass-sandbox', 'sandbox', 'sandbox-test'));
