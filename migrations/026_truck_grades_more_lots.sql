-- A gaadi can get a second lot line of the same maal and grade: "+ Zyada karein" when the
-- arrival was entered short, and the count of a gaadi that came in uncounted. The one-row-per-
-- grade rule refused exactly those rows, so the count stayed on the terminal and never synced.
ALTER TABLE truck_grades DROP CONSTRAINT truck_grades_lot_key;
