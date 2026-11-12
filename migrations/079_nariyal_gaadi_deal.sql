-- Nariyal: how a gaadi was taken, picked on Nayi gaadi before "Gaadi jodein".
--   commission = sold on commission for the supplier
--   purchase   = bought outright by the shop
-- NULL for every gaadi entered before this, and for every amrud / angoor / cheeku gaadi:
-- the server drops the field from a non-nariyal shop's push (SyncService.applyOne).

ALTER TABLE trucks ADD COLUMN deal text CHECK (deal IN ('commission', 'purchase'));
