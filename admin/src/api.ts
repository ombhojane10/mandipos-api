/**
 * mandipos-api's admin routes. Production calls the API directly (VITE_API_URL, set on the
 * Render static site; the API allows this origin via ADMIN_ORIGINS); local dev goes through
 * Vite's /api proxy.
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || '/api'
/** The owners' Android app, newest build (mandipos-api app_releases, flavor admin). */
export const APP_DOWNLOAD = `${BASE}/v1/public/app/download?flavor=admin`
/** True inside the installed app (the Android app, the Windows app, or the site added to the home screen). */
export const inApp = () => matchMedia('(display-mode: standalone)').matches || document.referrer.startsWith('android-app://')
  || navigator.userAgent.includes('MandiPlusDesktop/')

const TOKEN_KEY = 'mandipos-admin-token'

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
export function setToken(t: string | null) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY) } catch { /* private mode */ }
}

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

/** Called when the session is gone, so the app can show the login page. */
let onSignedOut = () => {}
export function whenSignedOut(fn: () => void) { onSignedOut = fn }

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  })
  if (res.status === 401 && token) { setToken(null); onSignedOut() }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string | string[] } | null
    const msg = Array.isArray(body?.message) ? body.message[0] : body?.message
    throw new ApiError(msg || `Request failed (${res.status})`, res.status)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** A POST whose answer is read as a stream (Bolo's speech), with the same sign-in as [api]. */
/** A file from the API (a PDF to look at), as a blob URL. */
export async function apiFile(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
  return URL.createObjectURL(await res.blob())
}

/** A file to save (the backup workbook), with the name the API gave it. */
export async function apiDownload(path: string): Promise<{ blob: Blob; name: string | null }> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
  if (res.status === 401 && getToken()) { setToken(null); onSignedOut() }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
  const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
  return { blob: await res.blob(), name: name ? decodeURIComponent(name) : null }
}

export async function apiStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw new ApiError(`Speech failed (${res.status})`, res.status)
  return res
}

export type ShopStatus = 'pending' | 'approved' | 'rejected'

export type Shop = {
  id: string; name: string; mandi: string; shopNo: string; gstin: string; commodity: string
  status: ShopStatus; createdAt: string; approvedAt: string | null; rejectReason: string
  owner: { name: string; phone: string }; members: number; devices: number; lastSeenAt: string | null
  todaySalesPaise: number
}

export type Device = { code: string | null; label: string; web: boolean; appVersion: string; phone: string; name: string; lastSeenAt: string | null; addedAt: string }
export type ShopDetail = Omit<Shop, 'devices'> & {
  team: { name: string; phone: string; role: 'admin' | 'accountant'; joinedAt: string }[]
  devices: Device[]
}

export type Summary = {
  from: string; to: string
  salesPaise: number; slips: number; nags: number; cashPaise: number; upiPaise: number; creditLeftPaise: number
  collectedCashPaise: number; collectedUpiPaise: number; collections: number
  labourPaise: number; spoiledNags: number; daybookInPaise: number; daybookOutPaise: number
  deletedSlips: number; deletedPaise: number
  duePaise: number; dueBuyers: number; stockNags: number; openTrucks: number
  series: { date: string; salesPaise: number; slips: number }[]
  topBuyers: { id: string; name: string; salesPaise: number; slips: number }[]
}

export type BuyerRow = {
  id: string; name: string; phone: string; code: string; kind: string; hidden: boolean; address?: string; destination?: string; area?: string
  balancePaise: number; lastSlipOn: string | null; boughtPaise: number
}

export type HistoryRow = {
  id: string; at: string; date: string; kind: 'slip' | 'payment' | 'udhaar'; title: string; detail: string
  nags: number; debitPaise: number; creditPaise: number; balancePaise: number
  lines?: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]
}

export type BuyerDetail = {
  buyer: { id: string; name: string; phone: string; code: string; kind: string; address: string; destination: string; area: string; vehicle: string; creditLimitPaise: number; marketPaise: number | null; since: string; gstin?: string; hidden?: boolean }
  totals: { balancePaise: number; boughtPaise: number; nags: number; slips: number; paidPaise: number; lastSlipOn: string | null }
  history: HistoryRow[]
}

/** One person across every shop, matched by mobile (key), or a single shop's grahak with none. */
export type MarketCustomer = {
  key: string; name: string; phone: string; balancePaise: number; boughtPaise: number; lastSlipOn: string | null
  shops: { shopId: string; shopName: string; buyerId: string; balancePaise: number }[]
}

export type Person = {
  key: string; name: string; phone: string
  profile: { address: string; destination: string; vehicle: string; kind: string }
  totals: { balancePaise: number; duePaise: number; boughtPaise: number; slips: number; nags: number; traders: number; owedTo: number }
  traders: {
    shopId: string; shopName: string; mandi: string; buyerId: string; name: string; code: string
    balancePaise: number; boughtPaise: number; slips: number; nags: number; lastSlipOn: string | null
    marketPaise: number | null; creditLimitPaise: number
  }[]
  history: (HistoryRow & { shopId: string; shopName: string })[]
}

export type DayEntry = {
  kind: 'slip' | 'payment' | 'in' | 'out'; id: string; at: string; date: string
  title: string; party: string; buyerId: string | null; nags: number
  amountPaise: number; cashPaise: number; upiPaise: number; udhaarPaise: number
  payMode: string; staff: string; voided: string | null; note?: string; mode?: string
}

export type Me = { phone: string; admin: boolean; shopIds: string[] | null; labourShopIds?: string[] }
export type Buckets = { d0_7: number; d8_30: number; d31: number }
export type Dashboard = {
  from: string; to: string
  now: { salesPaise: number; slips: number; purchasePaise: number; gaadis: number }
  before: { salesPaise: number; slips: number; purchasePaise: number; gaadis: number }
  trend: { date: string; salesPaise: number; purchasePaise: number }[]
  receivables: Buckets & { duePaise: number; count: number }
  payables: Buckets & { duePaise: number; count: number }
  cash: { galla: number; office: number; bank: number }
  items: ItemRow[]
}
export type ItemRow = { brand: string; group?: string; nags: number; amountPaise: number; slips: number; ratePaise: number }
export type CashBook = {
  pot: 'galla' | 'office' | 'bank'; from: string; to: string; openingPaise: number; inPaise: number; outPaise: number; closingPaise: number
  lines: { id: string; date: string; at: string; kind: 'bikri' | 'vasooli' | 'in' | 'out'; title: string; party: string; note: string; inPaise: number; outPaise: number; auto: boolean; balancePaise: number }[]
}
export type Outstanding = {
  totals: Buckets & { duePaise: number; count: number }
  rows: (Buckets & { buyerId: string; name: string; phone: string; code: string; duePaise: number; oldestDays: number | null; lastSlipOn: string | null; lastPaidAt: string | null })[]
}
export type Suppliers = {
  totals: Buckets & { duePaise: number; count: number }
  rows: (Buckets & { key: string; name: string; gaadis: number; openGaadis: number; purchasePaise: number; paidPaise: number; duePaise: number; lastAt: string | null })[]
}
export type SupplierKhata = {
  key: string; name: string
  totals: { purchasePaise: number; paidPaise: number; duePaise: number; gaadis: number; dana: number }
  history: { id: string; at: string; date: string; kind: 'gaadi' | 'payment'; title: string; detail: string; nags: number; debitPaise: number; creditPaise: number; balancePaise: number; open: boolean; sold: number; left: number }[]
}
export type Stock = {
  totals: { left: number; valuePaise: number; gaadis: number; stale: number }
  rows: { truckId: string; number: string; supplier: string; brands: string; arrivedOn: string; closedOn: string | null; ageDays: number; stale: boolean; received: number; sold: number; spoiled: number; left: number; valuePaise: number }[]
}

export type BankAccount = { holder: string; bank: string; ifsc: string; account: string; branch?: string; phone?: string; pan?: string }
export type ShopSettings = {
  name: string; mandi: string; shopNo: string; phad: string; gstin: string; commodity: string
  phone: string; dispatchPhone: string; slipCode: string; slipLimitPaise: number; udhaarRates: boolean; udhaarAlerts: boolean
  address: string; bankAccounts: BankAccount[]; printerHost: string; printerDots: number
  licenceNo: string; companyCode: string; contactPerson: string; email: string
}
