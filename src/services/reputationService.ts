/**
 * Reputation engine – computes an off-chain trust score from bond data and
 * attestation history stored in the identity DB.
 *
 * Score breakdown (max 100):
 *   Bond amount  : up to 50 pts  (50 pts at ≥ 1 ETH)
 *   Bond duration: up to 20 pts  (20 pts at ≥ 365 days bonded)
 *   Attestations : up to 30 pts  (30 pts at ≥ 5 attestations)
 */

import { pool } from '../db/pool.js'
import { cache } from '../cache/index.js'

export interface IdentityRecord {
  address: string
  bondedAmount: string
  bondStart: string | null
  attestationCount: number
  agreedFields?: Record<string, string>
}

export interface TrustScore {
  address: string
  score: number
  bondedAmount: string
  bondStart: string | null
  attestationCount: number
  agreedFields?: Record<string, string>
}

const BOND_SCORE_MAX = 50
const DURATION_SCORE_MAX = 20
const ATTESTATION_SCORE_MAX = 30

/** 1 ETH expressed in wei. */
const ONE_ETH_WEI = BigInt('1000000000000000000')

/** Points proportional to bonded amount; maxes out at ONE_ETH_WEI. */
export function computeBondScore(bondedAmountWei: string): number {
  try {
    const amount = BigInt(bondedAmountWei)
    if (amount <= 0n) return 0
    const score = Number((amount * BigInt(BOND_SCORE_MAX)) / ONE_ETH_WEI)
    return Math.min(BOND_SCORE_MAX, score)
  } catch {
    return 0
  }
}

/** Points proportional to days since bond start; maxes out at 365 days. */
export function computeDurationScore(bondStart: string | null, now = Date.now()): number {
  if (!bondStart) return 0
  const startMs = new Date(bondStart).getTime()
  if (isNaN(startMs) || startMs >= now) return 0
  const daysBonded = (now - startMs) / 86_400_000
  const score = (daysBonded / 365) * DURATION_SCORE_MAX
  return Math.min(DURATION_SCORE_MAX, Math.round(score))
}

/** Points proportional to attestation count; maxes out at 5 attestations. */
export function computeAttestationScore(count: number): number {
  if (count <= 0) return 0
  const score = (count / 5) * ATTESTATION_SCORE_MAX
  return Math.min(ATTESTATION_SCORE_MAX, Math.round(score))
}

/** Compute a full TrustScore from an Identity record. */
export function computeTrustScoreFromRecord(identity: IdentityRecord): TrustScore {
  const bondScore = computeBondScore(identity.bondedAmount)
  const durationScore = computeDurationScore(identity.bondStart)
  const attestationScore = computeAttestationScore(identity.attestationCount)
  const score = Math.min(100, bondScore + durationScore + attestationScore)

  return {
    address: identity.address,
    score,
    bondedAmount: identity.bondedAmount,
    bondStart: identity.bondStart,
    attestationCount: identity.attestationCount,
    ...(identity.agreedFields ? { agreedFields: identity.agreedFields } : {}),
  }
}

/**
 * Look up an identity by address and return its computed trust score,
 * or null when no record exists.
 * Uses Redis cache and Postgres DB.
 */
export async function getTrustScore(address: string): Promise<TrustScore | null> {
  const cacheKey = address.toLowerCase()
  
  // 1. Try cache
  const cached = await cache.get<TrustScore>('trust', cacheKey)
  if (cached) return cached

  // 2. Try DB
  const idResult = await pool.query(
    `SELECT address, bonded_amount as "bondedAmount", 
            bond_start as "bondStart"
     FROM identities
     WHERE address = $1`,
    [address]
  )

  if (idResult.rows.length === 0) {
    return null
  }

  const row = idResult.rows[0]
  const attResult = await pool.query(
    'SELECT COUNT(*)::int as count FROM attestations WHERE subject_address = $1',
    [address]
  )
  const attestationCount = parseInt(attResult.rows[0]?.count || '0', 10)
  const record: IdentityRecord = { ...row, attestationCount }
  const trustScore = computeTrustScoreFromRecord(record)

  // 3. Save to cache (TTL 1 hour)
  await cache.set('trust', cacheKey, trustScore, 3600)

  return trustScore
}

/**
 * Invalidate the trust score cache for a given address.
 */
export async function invalidateTrustScoreCache(address: string): Promise<void> {
  await cache.delete('trust', address.toLowerCase())
}
