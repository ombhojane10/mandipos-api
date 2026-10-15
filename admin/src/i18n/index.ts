/**
 * The website's three languages, as the app offers them: Hinglish (what every label is written
 * in, and the default), English, and Hindi. A label is wrapped as t('Kitne katta'); its English
 * and Hindi live in the dictionaries beside this file, keyed by the Hinglish itself, so a label
 * nobody has translated yet still reads in Hinglish rather than breaking. {name} in a label is
 * filled from vars. Changing the language reloads the page, so nothing needs to re-render.
 */
import { DICT } from './dict'

export type Lang = 'hinglish' | 'en' | 'hi'
export const LANGS: { key: Lang; label: string }[] = [
  { key: 'hinglish', label: 'Hinglish' }, { key: 'en', label: 'English' }, { key: 'hi', label: 'हिंदी' },
]
const KEY = 'mp.lang'

function load(): Lang {
  try { const v = localStorage.getItem(KEY); return v === 'en' || v === 'hi' ? v : 'hinglish' } catch { return 'hinglish' }
}
export const lang: Lang = load()
if (typeof document !== 'undefined') document.documentElement.lang = lang === 'hi' ? 'hi' : 'en'

export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l) } catch { /* private window: stays for this load only */ }
  location.reload()
}

export function t(s: string, vars?: Record<string, string | number>): string {
  const row = lang === 'hinglish' ? undefined : DICT[s]
  const out = row ? (lang === 'en' ? row[0] : row[1]) || s : s
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out
}
