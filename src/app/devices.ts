/**
 * Read-only device sessions and one-time pairing codes for the `/status` surface.
 *
 * The owner pairs a phone or a second computer from the Host machine; the surface then issues a signed session cookie
 * that can only be used under `/status`. Sessions live in the Store's key-value table, so they survive a restart and
 * are revoked by deleting one record. Pairing codes are short-lived and kept in memory: a restart invalidates them,
 * which is the safe direction.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { StatusSettings } from '../deployment.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

/** One paired device. `ua` is a short hash of the browser's User-Agent, never the header itself. */
export interface DeviceSession {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  ua: string
}
export type DeviceView = DeviceSession
/** Thrown when pairing would exceed the configured device limit. */
export class DeviceLimitError extends Error {
  constructor(readonly maxDevices: number) { super(`At most ${maxDevices} devices can be paired at once; revoke one first`) }
}
/** Result of redeeming a pairing code: the new device and its cookie value, or why it failed. */
export type PairResult = { device: DeviceSession; cookie: string } | { failure: 'invalid' | 'expired' | 'rate-limited' | 'limit' }
interface PairingCode { token: string; short: string; expiresAt: number }
const cookieName = 'dsh_superagent_status'
export { cookieName }
const BAS32 = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const MAX_TTL_DAYS = 90
const nowMs = (): number => Date.now()

/** Host dependencies of `Devices`: the key-value Store and the resolved status settings. */
export interface DevicesHost {
  readonly store: Pick<Store, 'get' | 'set' | 'delete' | 'keys'>
  readonly status: StatusSettings
  /** Injectable clock, for tests. */
  now?(): number
}

/**
 * Issues and verifies read-only device sessions and one-time pairing codes.
 *
 * A session cookie is `<id>.<expires-at-ms>.<HMAC>`; the Store record is authoritative, so a revoked or expired record
 * rejects the cookie even when its signature is still valid. A signed cookie cannot be forged from another device.
 */
export class Devices {
  private readonly codes = new Map<string, PairingCode>()
  private readonly attempts = new Map<string, number[]>()
  constructor(private readonly host: DevicesHost) {}
  private now(): number { return this.host.now?.() ?? nowMs() }
  private secret(): string {
    const stored = this.host.store.get(KV.status.secret)
    if (stored) return stored
    const secret = randomBytes(32).toString('hex')
    this.host.store.set(KV.status.secret, secret)
    return secret
  }
  private signature(id: string, expiresAt: number): string {
    return createHmac('sha256', this.secret()).update(`${id}.${expiresAt}`).digest('base64url')
  }
  private ttlMs(): number {
    const days = Math.min(MAX_TTL_DAYS, Math.max(1, this.host.status.sessionTtlDays))
    return days * 86_400_000
  }
  private record(id: string): DeviceSession | undefined {
    const device = this.host.store.get(KV.status.device(id))
    return device && device.id === id ? device : undefined
  }
  /** Active devices, oldest first, without decoding any cookie. */
  list(): DeviceSession[] {
    const now = new Date(this.now()).toISOString()
    return this.host.store.keys(KV.status.device)
      .map(key => this.host.store.get(key))
      .filter((device): device is DeviceSession => !!device && device.expiresAt > now)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }
  /** Create one device and its cookie value; the caller sets the cookie on the response. */
  pair(label: string, ua: string): PairResult {
    const now = this.now()
    const active = this.list()
    if (active.length >= this.host.status.maxDevices) return { failure: 'limit' }
    const id = randomBytes(9).toString('base64url')
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + this.ttlMs()).toISOString()
    const device: DeviceSession = { id, label: label || 'Device', createdAt, lastSeenAt: createdAt,
      expiresAt, ua: createHmac('sha256', this.secret()).update(ua).digest('hex').slice(0, 16) }
    this.host.store.set(KV.status.device(id), device)
    return { device, cookie: this.cookieValue(id, Date.parse(expiresAt)) }
  }
  private cookieValue(id: string, expiresAt: number): string {
    return `${id}.${expiresAt}.${this.signature(id, expiresAt)}`
  }
  /** The Set-Cookie value for a session, with attributes that keep it out of scripts and cross-site requests. */
  cookieHeader(value: string, secure: boolean): string {
    const maxAge = Math.floor(this.ttlMs() / 1000)
    return `${cookieName}=${value}; Path=/status; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  }
  /** The cookie value that clears a session. */
  clearCookie(): string {
    return `${cookieName}=; Path=/status; HttpOnly; SameSite=Strict; Max-Age=0`
  }
  /** Resolve a cookie to its live device, or undefined when missing, signed wrong, expired, or revoked. */
  authorize(cookie: string | undefined): DeviceSession | undefined {
    if (!cookie) return undefined
    const parts = cookie.split('.')
    if (parts.length !== 3) return undefined
    const [id, text, signature] = parts as [string, string, string]
    const expiresAt = Number(text)
    if (!id || !Number.isFinite(expiresAt) || expiresAt <= this.now()) return undefined
    const expected = Buffer.from(this.signature(id, expiresAt)), given = Buffer.from(signature)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
    const device = this.record(id)
    if (!device || Date.parse(device.expiresAt) !== expiresAt || device.expiresAt <= new Date(this.now()).toISOString()) return undefined
    // Record activity at minute granularity; the read path must not write on every request.
    if (this.now() - Date.parse(device.lastSeenAt) >= 60_000) {
      const touched = { ...device, lastSeenAt: new Date(this.now()).toISOString() }
      this.host.store.set(KV.status.device(id), touched)
      return touched
    }
    return device
  }
  /** Revoke one device; true only when it existed. The next request with its cookie is rejected. */
  revoke(id: string): boolean {
    if (!this.record(id)) return false
    this.host.store.delete(KV.status.device(id))
    return true
  }
  /** Revoke every device, for "lost phone" or a reset. */
  revokeAll(): number {
    const devices = this.list()
    for (const device of devices) this.host.store.delete(KV.status.device(device.id))
    return devices.length
  }
  /**
   * Record one failed pairing attempt by its rate-limit key and report whether the caller may try.
   * @returns false once the key has made 5 attempts in the last minute.
   */
  allowAttempt(key: string): boolean {
    const now = this.now()
    const recent = (this.attempts.get(key) ?? []).filter(at => now - at < 60_000)
    if (recent.length >= 5) { this.attempts.set(key, recent); return false }
    recent.push(now)
    this.attempts.set(key, recent)
    if (this.attempts.size > 1_000) for (const [other, times] of this.attempts) {
      if (!times.length || now - times.at(-1)! >= 60_000) this.attempts.delete(other)
    }
    return true
  }
  private pruneCodes(): void {
    const now = this.now()
    for (const [key, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(key)
  }
  /** Create a short code and a long token for one pairing session; both redeem the same one-time code. */
  createCode(): { code: string; token: string; expiresAt: string } {
    this.pruneCodes()
    const token = randomBytes(32).toString('base64url')
    const bytes = randomBytes(8)
    let short = ''
    for (let index = 0; index < 8; index++) short += BAS32[bytes[index]! % BAS32.length]
    const entry: PairingCode = { token, short, expiresAt: this.now() + this.host.status.pairCodeTtlSeconds * 1000 }
    this.codes.set(token, entry)
    this.codes.set(`short:${short}`, entry)
    return { code: short, token, expiresAt: new Date(entry.expiresAt).toISOString() }
  }
  /**
   * Redeem a code (the long token or the short code) for a device session. A code works once; an expired code is
   * removed so it cannot be retried.
   */
  redeem(input: string, label: string, ua: string): PairResult {
    const key = input.length > 20 ? input : `short:${input.toUpperCase()}`
    const code = this.codes.get(key)
    if (!code) return { failure: 'invalid' }
    if (code.expiresAt <= this.now()) {
      this.codes.delete(code.token); this.codes.delete(`short:${code.short}`)
      return { failure: 'expired' }
    }
    this.codes.delete(code.token); this.codes.delete(`short:${code.short}`)
    return this.pair(label, ua)
  }
}
