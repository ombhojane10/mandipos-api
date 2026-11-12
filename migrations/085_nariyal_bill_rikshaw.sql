-- Nariyal "Rikshaw jodein": the rickshaw fare the customer pays on a parchi. It is already inside
-- total_paise (what the customer owes) and is kept here too, so the books can hold it as owed to
-- the rickshaw wala (not bikri) and the app's Mazdoori screen can show it. 0 = no rickshaw.
-- Dropped from a non-nariyal shop's push (SyncService.applyOne).

ALTER TABLE bills ADD COLUMN rikshaw_paise bigint NOT NULL DEFAULT 0 CHECK (rikshaw_paise >= 0);
