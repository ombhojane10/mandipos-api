-- A slip from the website can name the Pine machine that should print it — the cashier's own,
-- at the counter (print_jobs.target_device). Every Pine machine now listens for slips sent to
-- it (print_stations.own_only); the shop's office station still takes every unaddressed slip,
-- and one its own machine hasn't taken within a minute, so nothing is left unprinted.
ALTER TABLE print_jobs ADD COLUMN target_device uuid;
ALTER TABLE print_stations ADD COLUMN own_only boolean NOT NULL DEFAULT false;
