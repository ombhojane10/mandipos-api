export type EntryKind = 'parchi' | 'vasooli' | 'kharcha' | 'supplier' | 'gaadi' | 'grahak' | 'udhaar'

export const ENTRY_TYPES: { kind: EntryKind; label: string; sub: string }[] = [
  { kind: 'parchi', label: 'Nayi Parchi', sub: 'Bikri' },
  { kind: 'vasooli', label: 'Vasooli', sub: 'Grahak se paisa' },
  { kind: 'kharcha', label: 'Kharcha / Aaya', sub: 'Day book' },
  { kind: 'supplier', label: 'Supplier ko diya', sub: 'Payment' },
  { kind: 'gaadi', label: 'Nayi Gaadi', sub: 'Kharid' },
  { kind: 'grahak', label: 'Naya Grahak', sub: 'Khata kholein' },
  { kind: 'udhaar', label: 'Udhaar / Jama', sub: 'Hisaab mein jodein' },
]

/** Opens an entry form from anywhere: the + button, the dashboard, or Alt+N. No kind = the menu. */
export const OPEN_ENTRY = 'mandipos:new-entry'
export const openEntry = (kind?: EntryKind) => dispatchEvent(new CustomEvent(OPEN_ENTRY, { detail: kind }))
