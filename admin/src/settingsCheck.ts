import type { ShopSettings } from './api'
import { t } from './i18n'

const MOBILE_RE = /^([6-9]\d{9})?$/

/** What is wrong with the shop's details, field by field (Company and Settings show it under the field). */
export function settingsProblems(f: ShopSettings): Partial<Record<keyof ShopSettings, string>> {
  const p: Partial<Record<keyof ShopSettings, string>> = {}
  if (!f.name.trim()) p.name = t('Firm ka naam daalein')
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) p.email = t('Email sahi likhein')
  if (f.gstin.trim() && !/^[0-9]{2}[A-Z0-9]{13}$/.test(f.gstin.trim().toUpperCase())) p.gstin = t('GSTIN 15 akshar ka hota hai')
  if (!MOBILE_RE.test(f.phone)) p.phone = t('Mobile number 10 ank ka hona chahiye')
  if (!MOBILE_RE.test(f.dispatchPhone)) p.dispatchPhone = t('Mobile number 10 ank ka hona chahiye')
  if (f.printerHost.trim() && !/^\d{1,3}(\.\d{1,3}){3}$/.test(f.printerHost.trim())) p.printerHost = t('IP aise likhein: 192.168.1.50')
  return p
}
