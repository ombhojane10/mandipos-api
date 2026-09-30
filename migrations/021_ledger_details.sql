-- What heads the customer ledger: the shop's full address and the bank accounts a customer
-- can pay into. "SHARMA TRADERS — HDFC BANK A/C, IFSC HDFC0000123, 50100012345678", and a
-- second firm's account under it. All optional; an admin adds them whenever they like.

ALTER TABLE shops
  ADD COLUMN address text NOT NULL DEFAULT '',
  -- [{ "holder": "SHARMA TRADERS", "bank": "HDFC BANK", "ifsc": "HDFC0000123", "account": "50100012345678" }]
  ADD COLUMN bank_accounts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(bank_accounts) = 'array');
