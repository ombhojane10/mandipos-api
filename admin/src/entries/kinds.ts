import { t } from '../i18n'

export type EntryKind = 'parchi' | 'vasooli' | 'kharcha' | 'supplier' | 'gaadi' | 'grahak' | 'udhaar'

export const ENTRY_TYPES: { kind: EntryKind; label: string; sub: string }[] = [
  { kind: 'parchi', label: t('Nayi Parchi'), sub: t('Bikri') },
  { kind: 'vasooli', label: t('Vasooli'), sub: t('Grahak se paisa') },
  { kind: 'kharcha', label: t('Kharcha / Aaya'), sub: t('Day book') },
  { kind: 'supplier', label: t('Supplier ko diya'), sub: t('Payment') },
  { kind: 'gaadi', label: t('Nayi Gaadi'), sub: t('Kharid') },
  { kind: 'grahak', label: t('Naya Grahak'), sub: t('Khata kholein') },
  { kind: 'udhaar', label: t('Udhaar / Jama'), sub: t('Hisaab mein jodein') },
]

/** Opens an entry form from anywhere: the + button, the dashboard, or Alt+N. No kind = the menu. */
export const OPEN_ENTRY = 'mandipos:new-entry'
export const openEntry = (kind?: EntryKind) => dispatchEvent(new CustomEvent(OPEN_ENTRY, { detail: kind }))

/** A parchi opened to alter, as the voucher has it (GET bills/:id). */
export type EditBill = {
  id: string; slipNo: number | null; buyerId: string | null; buyerName: string; payMode: string; truckId: string | null; truck: string | null
  totalPaise: number; paidPaise: number; cashPaise: number; upiPaise: number; labourPaise: number; packs: number
  packing: string; panniName: string; staff: string; upiBank: string
  lines: { grade: string; qty: number; ratePaise: number; leak: boolean; brand: string; truckId?: string; brandId?: string }[]
  delivery: { address: string; stand: string } | null
}
/** A raseed opened to alter (GET collections/:id). */
export type EditRaseed = { id: string; receiptNo: number | null; buyerId: string; buyerName: string; cashPaise: number; upiPaise: number; ref: string; upiBank: string }
export type Editing = { kind: 'parchi'; bill: EditBill } | { kind: 'vasooli'; raseed: EditRaseed }

/** Alter (A on a voucher): the entry's own form, filled in as it stands. */
export const EDIT_ENTRY = 'mandipos:edit-entry'
export const editEntry = (e: Editing) => dispatchEvent(new CustomEvent(EDIT_ENTRY, { detail: e }))

/** A buyer as the voice found it: on the list (id), or a new name to open a khata for (id null). */
type VoiceBuyer = { id: string | null; name: string; balancePaise?: number } | null

/**
 * What Bolo heard, resolved on the server against the shop's books: the entry form opens on it
 * and the counter checks it and saves. [notes]: what to look at (a name not on the list).
 */
export type VoiceDraft =
  | {
      kind: 'parchi'; buyer: VoiceBuyer; truckId: string | null
      lines: { grade: '1' | '2' | '3' | 'mix'; qty: number; ratePaise: number }[]
      pay: 'cash' | 'upi' | 'credit' | 'split' | 'after' | 'free' | null; cashPaise: number; upiPaise: number
      packing: 'loose' | 'katta' | 'panni' | null; size: 'katta10' | 'katta15' | 'katta20' | 'katta25' | null
      kattaName: string; kattas: number | null; panni: string; parchune: boolean; delivery: boolean; labour: boolean
      notes: string[]
    }
  | { kind: 'vasooli'; buyer: VoiceBuyer; cashPaise: number; upiPaise: number; notes: string[] }
  | { kind: 'kharcha'; dir: 'in' | 'out'; amountPaise: number; note: string; notes: string[] }
