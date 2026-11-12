-- Nariyal: an optional one-line "Remark" the counter types on a parchi; printed on the order
-- parchi only when there is one. '' = none. Other shops' remarks are dropped by sync.service.
ALTER TABLE bills ADD COLUMN remark text NOT NULL DEFAULT '' CHECK (length(remark) <= 120);
