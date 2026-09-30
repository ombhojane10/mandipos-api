-- Printing from anywhere: a slip made away from the counter prints on the shop's own printer.
--
-- "If I'm at home and tap print, it should print in the office." A printer on the office WiFi
-- can't be reached from home, so the slip comes here, and a machine in the office that is
-- always on (the Pine Labs terminal) collects it and prints it on the printer beside it.
-- The slip travels as the image the sender previewed, so what prints is what they saw.

CREATE TABLE print_stations (
  -- One row per machine that prints for its shop. Online = it asked for work recently.
  device_id     uuid PRIMARY KEY REFERENCES devices(id),
  shop_id       uuid NOT NULL REFERENCES shops(id),
  name          text NOT NULL DEFAULT '',
  -- The printer's head width, so a sender draws the slip to fit it (384 = 2 inch, 576 = 3 inch).
  width_dots    int NOT NULL DEFAULT 384 CHECK (width_dots BETWEEN 200 AND 1280),
  last_poll_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX print_stations_shop ON print_stations (shop_id, last_poll_at);

CREATE TABLE print_jobs (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  from_device   uuid NOT NULL REFERENCES devices(id),
  -- What both ends show: "Order parchi #20".
  title         text NOT NULL DEFAULT '',
  -- The slip as a 1-bit PNG, a few KB. Dropped once the job is done with.
  image         bytea,
  width_dots    int NOT NULL CHECK (width_dots BETWEEN 200 AND 1280),
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'printing', 'printed', 'failed', 'expired')),
  station       uuid REFERENCES devices(id),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  finished_at   timestamptz
);

CREATE INDEX print_jobs_queue ON print_jobs (shop_id, status, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON print_stations TO mandipos_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON print_jobs TO mandipos_api;
