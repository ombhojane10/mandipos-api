/**
 * Cheeku's own lines in the shop's books (BooksService). A cheeku shop keeps beejak books, as a
 * grapes shop does, but from its own copies: its own beejak postings fragment, account names and
 * supplier creditors (CheekuCreditorsService), so editing the grapes postings never moves cheeku's.
 */

/** BooksService's book mode for a cheeku shop ($3 in the postings SQL). */
export const CHEEKU_BOOKS = 'cheeku';

/** The beejak is the purchase document. Gross to kharid, net to the party, deductions to income. */
export const CHEEKU_BEEJAKS_FRAGMENT = `
    SELECT b.day AS day, v.acct, v.dr, v.cr, 'beejak' AS kind, b.id AS ref, b.truck_id AS ref2, b.created_at AS at, 'Beejak #' || b.beejak_no AS title, concat_ws(' · ', b.party, 'Gaadi ' || b.gaadi) AS detail
    FROM beejaks b CROSS JOIN LATERAL (
      SELECT 'purchase'::text AS acct, b.gross_paise AS dr, 0::bigint AS cr
      UNION ALL SELECT CASE WHEN trim(b.party) <> '' THEN 'creditors' ELSE 'diff:beejak' END, 0, b.net_paise
      UNION ALL SELECT 'bj:' || (x->>'key'), 0, (x->>'amountPaise')::bigint FROM jsonb_array_elements(b.expenses) x
    ) v
    WHERE $3 = '${CHEEKU_BOOKS}' AND b.day <= $1`;

export const CHEEKU_PURCHASE_NAME = 'Kharid (beejak)';

export const CHEEKU_BEEJAK_NAME: Record<string, string> = {
  commission: 'Commission', association: 'Association', loading: 'Loading', labour: 'Labour (beejak)', bardana: 'Bardana', freight: 'Bhada (beejak)',
  dak: 'Dak', bank: 'Bank charges', crate: 'Crate', store: 'Store', custom: 'Custom', other: 'Other',
};
