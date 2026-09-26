-- The phad (stall) numbers, renamed to `phad` by 007 that print under the firm name: "ASHISH BROTHERS / B-142 Fard 1,2,3".
--
-- They belong to the shop, not to a terminal, so every machine at the counter prints the same
-- head. The app kept them locally until now, which meant a second terminal printed without them.

ALTER TABLE shops ADD COLUMN fard text NOT NULL DEFAULT '';
