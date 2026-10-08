-- The shop's WiFi receipt printer, set once for the whole shop. Before this every phone and
-- tablet had to find or type the printer's IP itself; now whichever device finds it saves it
-- here and every other device of the shop has it on its next /v1/me.
ALTER TABLE shops ADD COLUMN printer_host text NOT NULL DEFAULT ''
  CHECK (printer_host = '' OR printer_host ~ '^\d{1,3}(\.\d{1,3}){3}$');
-- Head width in dots: 576 = 3 inch, 832 = 4 inch.
ALTER TABLE shops ADD COLUMN printer_dots int NOT NULL DEFAULT 576 CHECK (printer_dots IN (384, 576, 832));

-- Which printer the office station prints on (TERMINAL, SEZNIK, WIFI). A device away from the
-- office sends to the station; when the station prints on the shop's WiFi printer, that is the
-- same printer, so the sender shows one choice instead of two.
ALTER TABLE print_stations ADD COLUMN roll text NOT NULL DEFAULT '';
