-- A paid slip can be deleted two more ways: the money handed back ('refunded') or kept as the
-- grahak's advance ('advance'). Either way the slip is cancelled and its dana go back on the gaadi;
-- the reason only tells the deleted history what happened to the money.
ALTER TABLE bill_voids DROP CONSTRAINT IF EXISTS bill_voids_reason_check;
ALTER TABLE bill_voids ADD CONSTRAINT bill_voids_reason_check
  CHECK (reason IN ('deleted', 'edited', 'refunded', 'advance'));
