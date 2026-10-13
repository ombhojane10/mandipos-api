-- The letters boxed at the head of every slip. '' = derive them from the firm name's
-- initials ("Ashish Brothers" -> AB), as before; a shop whose name doesn't initial the way
-- it is known (AL Shamsh Trading Co. -> ATC, not AST) sets its own.
ALTER TABLE shops ADD COLUMN slip_code text NOT NULL DEFAULT ''
  CHECK (slip_code = '' OR slip_code ~ '^[A-Z0-9&]{1,6}$');
