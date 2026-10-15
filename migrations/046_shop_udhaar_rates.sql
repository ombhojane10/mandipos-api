-- Whether this shop's udhaar order slips print the bhav and rakam. Ashish Brothers keeps rates off
-- udhaar paper (the rate lives in the register, not on what the grahak carries away), so the
-- default is off; Mohit Jaipur prints them on every slip, udhaar too.
ALTER TABLE shops ADD COLUMN udhaar_rates boolean NOT NULL DEFAULT false;
