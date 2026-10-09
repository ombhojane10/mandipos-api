-- A station that couldn't reach the printer sits out for a while.
--
-- A phone registered as a station and then carried home kept claiming the shop's slips and
-- failing every one of them ("printer tak nahi pahunche"). Now such a slip goes back to the
-- queue, and the device that failed it is not handed another until cooldown_until passes, so
-- a device that is actually beside the printer prints it.
ALTER TABLE print_stations ADD COLUMN cooldown_until timestamptz;
