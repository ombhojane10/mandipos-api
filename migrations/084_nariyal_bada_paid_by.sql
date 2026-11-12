-- Nariyal Bada "All paid": who paid the gaadi wala off (picked on the app: an accountant or the
-- shopkeeper), printed on the Bada parchi. NULL = not paid, or paid before this was asked.
-- Like the other Bada fields, dropped from a non-nariyal shop's push (SyncService.applyOne).

ALTER TABLE trucks ADD COLUMN bada_paid_by text CHECK (bada_paid_by IS NULL OR length(bada_paid_by) <= 40);
