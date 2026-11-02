import { t } from '../i18n'

// Cheeku's own copy of Bolo's topic list (BoloChat topics(), the grapes branch): boxes off lots,
// dispatch at the gaadi. Grapes and cheeku never share it: edit one, the other stays as it is.
export type CheekuTopic = { key: string; label: string; asks: string[] }

export function cheekuTopics(top: string): CheekuTopic[] {
  const who = top || 'Ramesh'
  return [
    { key: 'bill', label: t('Bill'), asks: [`${who} ko 10 box Tiger 900 ke udhaar mein bill kaat do`, 'Cash mein 5 box Royal 1200 ke', 'Aakhri parchi mein rate 950 kar do'] },
    { key: 'dispatch', label: t('Dispatch'), asks: ['Aaj dispatch kitna baaki hai', 'Kis parchi ka maal abhi nahi gaya', 'Aaj kitne box de diye'] },
    { key: 'udhaar', label: t('Udhaar'), asks: ['Sabse zyada udhaar kiska hai', `${who} ka udhaar kitna hai`, `${who} ko udhaar WhatsApp karo`] },
    { key: 'gaadi', label: t('Gaadi'), asks: ['Kaunsi gaadi kahan khadi hai', 'Kis gaadi ka kitna maal bika', 'Nayi gaadi aayi hai'] },
    { key: 'hisab', label: t('Hisab'), asks: ['Aaj ki bikri kitni hui', 'Aaj galla mein kitna hai', 'Aaj kitna kharcha hua'] },
    { key: 'yaad', label: t('Yaad'), asks: [`Kal subah yaad dilana ${who} se paise lene hain`, 'Mere reminder dikhao'] },
  ]
}
