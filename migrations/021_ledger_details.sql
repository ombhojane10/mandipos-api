-- What heads the customer ledger: the shop's full address and the bank accounts a customer
-- can pay into. "ASHISH BROTHERS — IDFC BANK A/C, IFSC IDFB0020254, 80913380910", and a
-- second firm's account under it. All optional; an admin adds them whenever they like.

ALTER TABLE shops
  ADD COLUMN address text NOT NULL DEFAULT '',
  -- [{ "holder": "ASHISH BROTHERS", "bank": "IDFC BANK", "ifsc": "IDFB0020254", "account": "80913380910" }]
  ADD COLUMN bank_accounts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(bank_accounts) = 'array');
