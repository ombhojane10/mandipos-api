-- Two terminals, one shop, one run of slip numbers. A terminal that is offline (light gone, the
-- tab off the wifi) keeps numbering from what it last saw, so it can hand out a number another
-- terminal already used. The server used to refuse that slip — and with it every row of the same
-- entry — and the terminal retried it forever: the slip, its money and its dana stayed on that
-- one machine and never reached the books.
--
-- Now the slip that reaches the server second is kept under the shop's next free number, and the
-- number the terminal asked for is remembered beside it. The terminal learns the new number from
-- the feed and tells the counter. The same for raseed numbers on collections.
-- The corrected copy of a renumbered slip (Badlein made before the terminal synced) finds the
-- number its original got through asked_*, so an edit never moves a slip twice.

ALTER TABLE bills ADD COLUMN asked_slip_no integer;
ALTER TABLE collections ADD COLUMN asked_receipt_no integer;

CREATE INDEX bills_asked_slip_no ON bills (shop_id, device_id, asked_slip_no) WHERE asked_slip_no IS NOT NULL;
CREATE INDEX collections_asked_receipt_no ON collections (shop_id, device_id, asked_receipt_no) WHERE asked_receipt_no IS NOT NULL;
