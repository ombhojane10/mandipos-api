/**
 * mandipos-api's admin routes. Production calls the API directly (VITE_API_URL, set on the
 * Render static site; the API allows this origin via ADMIN_ORIGINS); local dev goes through
 * Vite's /api proxy.
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || '/api'

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

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (res.status === 401 && token) { setToken(null); onSignedOut() }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string | string[] } | null
    const msg = Array.isArray(body?.message) ? body.message[0] : body?.message
    throw new ApiError(msg || `Request failed (${res.status})`, res.status)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export type ShopStatus = 'pending' | 'approved' | 'rejected'

export type Shop = {
  id: string; name: string; mandi: string; shopNo: string; gstin: string; commodity: string
  status: ShopStatus; createdAt: string; approvedAt: string | null; rejectReason: string
  owner: { name: string; phone: string }; members: number; devices: number; lastSeenAt: string | null
  todaySalesPaise: number
}

export type ShopDetail = Shop & {
  team: { name: string; phone: string; role: 'admin' | 'accountant'; joinedAt: string }[]
  devices: { code: string | null; label: string; appVersion: string; phone: string; lastSeenAt: string | null }[]
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
  id: string; name: string; phone: string; code: string; kind: string; hidden: boolean
  balancePaise: number; lastSlipOn: string | null; boughtPaise: number
}

export type HistoryRow = {
  id: string; at: string; date: string; kind: 'slip' | 'payment' | 'udhaar'; title: string; detail: string
  nags: number; debitPaise: number; creditPaise: number; balancePaise: number
  lines?: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]
}

export type BuyerDetail = {
  buyer: { id: string; name: string; phone: string; code: string; kind: string; address: string; destination: string; vehicle: string; creditLimitPaise: number; marketPaise: number | null; since: string }
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
