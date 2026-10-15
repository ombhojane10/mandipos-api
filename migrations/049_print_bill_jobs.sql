-- A slip made on the website has no printer of its own: it is queued for the shop's print
-- machine as a reference to the bill rather than a picture. The machine draws it from its own
-- books, so it prints exactly as a slip made at the counter would.
ALTER TABLE print_jobs ADD COLUMN bill_id uuid;
