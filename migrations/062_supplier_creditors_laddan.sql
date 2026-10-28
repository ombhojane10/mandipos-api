-- Guru Kripa's two masters from their old software.
--
-- Supplier creditors (angoor): the supplier list (supplier_phones, synced) gains a manual code,
-- an area and an opening balance with the date it stood at. A saved beejak's net is what the shop
-- owes the supplier; a supplier payment (daybook 'supplier') pays it. Read April to March: each
-- year's closing is the next year's opening, never zeroed.
ALTER TABLE supplier_phones
  ADD COLUMN code          text NOT NULL DEFAULT '',
  ADD COLUMN area          text NOT NULL DEFAULT '',
  ADD COLUMN opening_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN opening_on    date;

-- Laddan: a party in another mandi the shop sends maal to on sale (kind 'laddan' on buyers).
-- They sell it, keep their aadhat and send the money back; the price stays with the shop. The
-- master carries what the old Ladaan Master did.
ALTER TABLE buyers
  ADD COLUMN city           text NOT NULL DEFAULT '',
  ADD COLUMN district       text NOT NULL DEFAULT '',
  ADD COLUMN state          text NOT NULL DEFAULT '',
  ADD COLUMN contact_person text NOT NULL DEFAULT '',
  ADD COLUMN email          text NOT NULL DEFAULT '',
  ADD COLUMN area           text NOT NULL DEFAULT '',
  ADD COLUMN bank_details   text NOT NULL DEFAULT '';
