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
