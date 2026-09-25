-- Brands (origins) and a dated rate sheet.
--
-- The trade prices tender coconut by where it came from — V. Kota, Pollachi, Bangalore,
-- Gujarat — and then by size grade (1st/2nd/3rd) within that origin. Origin moves the price
-- far more than grade does, and rates are re-marked through the day as trucks land, so rates
-- live in a dated sheet per (brand, grade) rather than in a single master row: that keeps
-- history and makes "copy yesterday" trivial.
--
-- A truck can carry more than one brand, so brand belongs to the lot line inside the truck,
-- and the purchase rate moves there with it. Freight, unloading and commission stay on the
-- truck and are spread across its nuts.

-- ---------------------------------------------------------------- brands

CREATE TABLE brands (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  sort_order   int NOT NULL DEFAULT 0,
  hidden       boolean NOT NULL DEFAULT false,
  -- How many days this origin stays sellable; drives the ageing warning on stock.
  -- Karnataka nuts keep about a week, Gujarat about two days.
  shelf_days   int NOT NULL DEFAULT 7 CHECK (shelf_days BETWEEN 1 AND 60),
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

CREATE INDEX brands_shop ON brands (shop_id, sort_order);

-- ---------------------------------------------------------------- rate sheet

-- One row per shop-day-brand-grade. Last write wins, like the other masters, so a correction
-- from any terminal settles; yesterday's rows stay for history and for copying forward.
CREATE TABLE rates (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  business_date  date NOT NULL,
  brand_id       uuid NOT NULL,
  grade          text NOT NULL CHECK (grade IN ('1', '2', '3', 'mix')),
  rate_paise     bigint NOT NULL CHECK (rate_paise >= 0),
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, brand_id) REFERENCES brands (shop_id, id),
  UNIQUE (shop_id, business_date, brand_id, grade),
  UNIQUE (shop_id, id)
);

CREATE INDEX rates_day ON rates (shop_id, business_date);

-- ---------------------------------------------------------------- grades: A/B/C -> 1/2/3

-- Only the pilot shop's test rows exist so far, so the old letters map straight across:
-- A (bada) -> 1st, B (medium) -> 2nd, C (chhota) -> 3rd.
ALTER TABLE truck_grades DROP CONSTRAINT truck_grades_grade_check;
ALTER TABLE bill_lines   DROP CONSTRAINT bill_lines_grade_check;
ALTER TABLE spoilage     DROP CONSTRAINT spoilage_grade_check;

UPDATE truck_grades SET grade = CASE grade WHEN 'A' THEN '1' WHEN 'B' THEN '2' WHEN 'C' THEN '3' ELSE grade END;
UPDATE bill_lines   SET grade = CASE grade WHEN 'A' THEN '1' WHEN 'B' THEN '2' WHEN 'C' THEN '3' ELSE grade END;
UPDATE spoilage     SET grade = CASE grade WHEN 'A' THEN '1' WHEN 'B' THEN '2' WHEN 'C' THEN '3' ELSE grade END;

ALTER TABLE truck_grades ADD CONSTRAINT truck_grades_grade_check CHECK (grade IN ('1', '2', '3', 'mix'));
ALTER TABLE bill_lines   ADD CONSTRAINT bill_lines_grade_check   CHECK (grade IN ('1', '2', '3', 'mix'));
ALTER TABLE spoilage     ADD CONSTRAINT spoilage_grade_check     CHECK (grade IN ('1', '2', '3', 'mix'));

-- ---------------------------------------------------------------- lots carry brand and cost

-- truck_grades is now the lot line: this many nuts of this brand and grade, bought at this rate.
ALTER TABLE truck_grades ADD COLUMN brand_id    uuid,
                         ADD COLUMN billed_qty  int NOT NULL DEFAULT 0 CHECK (billed_qty >= 0),
                         ADD COLUMN free_qty    int NOT NULL DEFAULT 0 CHECK (free_qty >= 0),
                         ADD COLUMN rate_paise  bigint NOT NULL DEFAULT 0 CHECK (rate_paise >= 0);
ALTER TABLE truck_grades ADD CONSTRAINT truck_grades_brand_fk FOREIGN KEY (shop_id, brand_id) REFERENCES brands (shop_id, id);
ALTER TABLE truck_grades DROP CONSTRAINT truck_grades_truck_id_grade_key;
ALTER TABLE truck_grades ADD CONSTRAINT truck_grades_lot_key UNIQUE (truck_id, brand_id, grade);
CREATE INDEX truck_grades_brand ON truck_grades (shop_id, brand_id);

-- Bill lines and spoilage record the brand they came off, so reports don't have to walk the lot.
ALTER TABLE bill_lines ADD COLUMN brand_id uuid;
ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_brand_fk FOREIGN KEY (shop_id, brand_id) REFERENCES brands (shop_id, id);
ALTER TABLE spoilage   ADD COLUMN brand_id uuid;
ALTER TABLE spoilage   ADD CONSTRAINT spoilage_brand_fk FOREIGN KEY (shop_id, brand_id) REFERENCES brands (shop_id, id);

-- ---------------------------------------------------------------- truck-level costs

-- Purchase rate and nut counts moved to the lot lines above; keep the columns for the rows
-- written before this migration, but stop requiring them.
ALTER TABLE trucks ALTER COLUMN billed_qty DROP NOT NULL,
                   ALTER COLUMN rate_paise DROP NOT NULL;
ALTER TABLE trucks DROP CONSTRAINT trucks_billed_qty_check;

-- Arhat (6% at Azadpur) plus the 1% market fee, as an amount: part of landed cost.
ALTER TABLE trucks ADD COLUMN commission_paise bigint NOT NULL DEFAULT 0 CHECK (commission_paise >= 0);

-- ---------------------------------------------------------------- access

GRANT SELECT, INSERT, UPDATE ON brands, rates TO mandipos_api;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['brands', 'rates']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY shop_isolation ON %I TO mandipos_api
         USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
         WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
