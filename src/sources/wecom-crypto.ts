/**
 * WeCom (企业微信) callback security: the SHA-1 message signature included in every callback, and the
 * AES-256-CBC envelope that carries the event body. See docs/009-wecom-dingtalk-sources.md.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** The signature WeCom puts in `msg_signature`: SHA-1 of the token, timestamp, nonce and encrypted body sorted as strings. */
export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex')
}
/** Compares a computed signature with the callback's `msg_signature` without leaking where they differ. */
export function wecomSignatureMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected), b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}
/** The 32-byte AES key behind a 43-character EncodingAESKey. */
export function wecomKey(encodingAESKey: string): Buffer {
  const key = Buffer.from(`${encodingAESKey}=`, 'base64')
  if (key.length !== 32) throw new Error('EncodingAESKey must decode to 32 bytes')
  return key
}
/**
 * Opens a callback envelope, which carries a 16-byte random prefix, a 4-byte big-endian body length,
 * the body, and the receiving corporation's id. The id must match the configured corporation.
 */
export function decryptWecom(encrypt: string, encodingAESKey: string, receiveId: string): string {
  const key = wecomKey(encodingAESKey)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(encrypt, 'base64'), decipher.final()])
  const pad = plain.at(-1) ?? 0
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('The callback body has an invalid padding')
  const raw = plain.subarray(0, plain.length - pad)
  if (raw.length < 20) throw new Error('The callback body is too short')
  const length = raw.readUInt32BE(16)
  if (20 + length > raw.length) throw new Error('The callback body length is invalid')
  const body = raw.subarray(20, 20 + length).toString('utf8')
  const receiver = raw.subarray(20 + length).toString('utf8')
  if (receiver !== receiveId) throw new Error('The callback belongs to another corporation')
  return body
}
/**
 * Seals a body the way WeCom does; the Agent only receives callbacks, but tests and a local simulator need the
 * counterpart so they exercise the real signature and encryption instead of a stub.
 */
export function encryptWecom(message: string, encodingAESKey: string, receiveId: string, random = randomBytes(16)): string {
  const key = wecomKey(encodingAESKey)
  if (random.length !== 16) throw new Error('The random prefix must be 16 bytes')
  const body = Buffer.from(message, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const raw = Buffer.concat([random, length, body, Buffer.from(receiveId, 'utf8')])
  const pad = 32 - raw.length % 32
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64')
}
/** Reads one flat XML element's text, accepting both a CDATA section and an escaped text node. */
export function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`).exec(xml)
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? undefined : unescapeXml(value)
}
/** Unescapes the XML entities WeCom emits outside CDATA. */
export function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
