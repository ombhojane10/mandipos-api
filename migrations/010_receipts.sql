-- The vasooli raseed: a numbered, printed receipt, and cash + UPI in the same payment.
--
-- "Customer name, amount received, cash or UPI, slip number, end of story. Signature." The
-- collection was already recorded; what it lacked was a number of its own to print and the
-- ability to say "he gave some money in UPI, gave some in cash" — which is one payment, not two.

ALTER TABLE collections
  -- Counted from 1 per shop, like the parchi's serial, so a receipt can be found again.
  ADD COLUMN receipt_no int CHECK (receipt_no > 0),
  ADD COLUMN cash_paise bigint NOT NULL DEFAULT 0 CHECK (cash_paise >= 0),
  ADD COLUMN upi_paise  bigint NOT NULL DEFAULT 0 CHECK (upi_paise >= 0);

CREATE UNIQUE INDEX collections_receipt_no ON collections (shop_id, receipt_no)
  WHERE receipt_no IS NOT NULL;

-- Existing rows came in through one mode each.
UPDATE collections SET cash_paise = amount_paise WHERE pay_mode = 'cash';
UPDATE collections SET upi_paise  = amount_paise WHERE pay_mode IN ('upi', 'card');

-- A split payment has no single mode; the column stays for the older rows and for filtering.
ALTER TABLE collections DROP CONSTRAINT collections_pay_mode_check;
ALTER TABLE collections ADD CONSTRAINT collections_pay_mode_check
  CHECK (pay_mode IN ('cash', 'upi', 'card', 'mixed'));

UPDATE changes c SET row = to_jsonb(x) FROM collections x
  WHERE c.table_name = 'collections' AND c.row_id = x.id;
