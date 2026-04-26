import { createHmac, timingSafeEqual } from 'node:crypto'

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_secret' | 'missing_signature' | 'malformed_signature' | 'invalid_signature' }

/**
 * Parse and normalise a raw signature header value.
 *
 * Accepts:
 *   - bare 64-char lowercase hex
 *   - "sha256=<64-char hex>"  (case-insensitive prefix)
 *
 * Returns null for any other input, including empty strings, non-hex chars,
 * wrong length, or null/undefined.
 */
export function parseSignatureHeader(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  const candidate = trimmed.toLowerCase().startsWith('sha256=')
    ? trimmed.slice('sha256='.length).trim()
    : trimmed.toLowerCase()

  // Must be exactly 64 lowercase hex chars (SHA-256 output)
  if (!/^[0-9a-f]{64}$/.test(candidate)) return null

  return candidate
}

/**
 * Compute HMAC-SHA256 of `body` with `secret` and return the hex digest.
 */
export function computeHmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Returns false immediately (without timing leak) when lengths differ —
 * both inputs are always 64-char hex so this is a safety guard only.
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/**
 * Verify an inbound webhook signature.
 *
 * @param rawSignature - Value of the signature header (may be null/undefined).
 * @param body         - Raw request body string used to compute the expected HMAC.
 * @param secret       - Shared secret (may be null/undefined — treated as missing).
 *
 * All null/undefined paths return a typed failure rather than throwing.
 */
export function verifySignature(
  rawSignature: string | null | undefined,
  body: string,
  secret: string | null | undefined,
): VerifyResult {
  if (!secret) return { ok: false, reason: 'missing_secret' }

  if (rawSignature == null || rawSignature === '') {
    return { ok: false, reason: 'missing_signature' }
  }

  const received = parseSignatureHeader(rawSignature)
  if (!received) return { ok: false, reason: 'malformed_signature' }

  const expected = computeHmac(body, secret)

  if (!safeCompareHex(expected, received)) {
    return { ok: false, reason: 'invalid_signature' }
  }

  return { ok: true }
}
