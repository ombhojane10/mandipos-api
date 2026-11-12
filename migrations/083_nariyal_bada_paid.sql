-- Nariyal Bada: "All paid". When the gaadi wala was paid off on his Bada (the app's All paid
-- button); NULL = not yet. A mark only: no money moves, the payout is written wherever the shop
-- writes it. Like the other Bada fields, dropped from a non-nariyal shop's push (SyncService.applyOne).

ALTER TABLE trucks ADD COLUMN bada_paid_at timestamptz;
