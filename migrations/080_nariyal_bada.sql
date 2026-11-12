-- Nariyal Bada: the gaadi wale's account for a gaadi, beside its bhada (freight_paise).
--   advance_paise = paid to the gaadi wala already          (comes off the bhada)
--   dala_paise    = unloading                              (comes off)
--   inaam_paise   = reward                                 (goes on)
--   fine_paise    = fine                                   (comes off)
--   halting_paise = the gaadi stood days; the gaadi wala pays (comes off)
-- 0 for every gaadi before this and for every amrud / angoor / cheeku gaadi: the server drops
-- these fields from a non-nariyal shop's push (SyncService.applyOne).

ALTER TABLE trucks
  ADD COLUMN advance_paise bigint NOT NULL DEFAULT 0 CHECK (advance_paise >= 0),
  ADD COLUMN dala_paise    bigint NOT NULL DEFAULT 0 CHECK (dala_paise >= 0),
  ADD COLUMN inaam_paise   bigint NOT NULL DEFAULT 0 CHECK (inaam_paise >= 0),
  ADD COLUMN fine_paise    bigint NOT NULL DEFAULT 0 CHECK (fine_paise >= 0),
  ADD COLUMN halting_paise bigint NOT NULL DEFAULT 0 CHECK (halting_paise >= 0);
