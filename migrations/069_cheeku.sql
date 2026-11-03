-- A fourth commodity: cheeku (sapota), sold exactly the way angoor is — on commission, a party
-- sends boxes of several qualities on a gaadi, the shop sells them and settles the party.
--
-- Cheeku runs the whole angoor flow (gaadi location, box weight, 1% APMC, QR pickups, store /
-- broken / sample spoilage, accountants, beejak, supplier creditors, WhatsApp slips); only the
-- name differs. The columns and tables migrations 055–068 added for angoor already carry it, so
-- the only change is letting a shop say it sells cheeku. The code decides "angoor flow" with
-- grapesFlow() (src/common/commodity.ts), true for both.

ALTER TABLE shops DROP CONSTRAINT shops_commodity_check;
ALTER TABLE shops ADD CONSTRAINT shops_commodity_check CHECK (commodity IN ('nariyal', 'amrud', 'angoor', 'cheeku'));
