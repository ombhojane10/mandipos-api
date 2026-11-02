/**
 * Cheeku's own switches on the website, kept apart from the grapes ones so either can change
 * alone. They start as the grapes values.
 */

/** Cheeku shops write every name (grahak, supplier, party) in capitals. */
export const CHEEKU_CAPS_NAMES = true

/** A cheeku shop's ledgers show no A/B/C grade column: it sells by quality. */
export const CHEEKU_LEDGER_GRADES = false

/** Cheeku keeps beejak books: its suppliers open as creditors (the cheeku creditors page). */
export const cheekuCreditorReport = 'cheeku-creditors' as const

/** The APMC switch shows on the console's slip settings for a cheeku shop. */
export const CHEEKU_APMC_SETTING = true
