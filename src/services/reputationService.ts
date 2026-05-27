/**
 * Reputation engine – computes an off-chain trust score from bond data and
 * attestation history stored in the identity DB.
 *
 * Score breakdown (max 100, configurable via environment):
 *   Bond amount  : up to REPUTATION_BOND_SCORE_MAX pts (default: 50 pts at ≥ 1 ETH)
 *   Bond duration: up to REPUTATION_DURATION_SCORE_MAX pts (default: 20 pts at ≥ 365 days bonded)
 *   Attestations : up to REPUTATION_ATTESTATION_SCORE_MAX pts (default: 30 pts at ≥ 5 attestations)
 *
 * All scoring weights are externalized to config and versioned via REPUTATION_MODEL_VERSION.
 */

import { getIdentity, type Identity } from '../db/store.js'
import { loadConfig } from '../config/index.js'

export interface TrustScore {
  address: string
  score: number
  bondedAmount: string
  bondStart: string | null
  attestationCount: number
  agreedFields?: Record<string, string>
  scoringModelVersion?: string
}

export interface ScoringConfig {
  bondScoreMax: number
  durationScoreMax: number
  attestationScoreMax: number
  oneEthWei: bigint
  maxDurationDays: number
  maxAttestationCount: number
  scoringModelVersion: string
}

// Load config once at module initialization
const config = loadConfig()
const scoringConfig: ScoringConfig = config.reputation

/**
 * Get the current scoring configuration.
 * Useful for testing and introspection.
 */
export function getScoringConfig(): ScoringConfig {
  return { ...scoringConfig }
}

/** Points proportional to bonded amount; maxes out at configured ONE_ETH_WEI. */
export function computeBondScore(
  bondedAmountWei: string,
  cfg: ScoringConfig = scoringConfig
): number {
  try {
    const amount = BigInt(bondedAmountWei)
    if (amount <= 0n) return 0
    const score = Number((amount * BigInt(cfg.bondScoreMax)) / cfg.oneEthWei)
    return Math.min(cfg.bondScoreMax, score)
  } catch {
    return 0
  }
}

/** Points proportional to days since bond start; maxes out at configured max duration. */
export function computeDurationScore(
  bondStart: string | null,
  now = Date.now(),
  cfg: ScoringConfig = scoringConfig
): number {
  if (!bondStart) return 0
  const startMs = new Date(bondStart).getTime()
  if (isNaN(startMs) || startMs >= now) return 0
  const daysBonded = (now - startMs) / 86_400_000
  const score = (daysBonded / cfg.maxDurationDays) * cfg.durationScoreMax
  return Math.min(cfg.durationScoreMax, Math.round(score))
}

/** Points proportional to attestation count; maxes out at configured max attestation count. */
export function computeAttestationScore(
  count: number,
  cfg: ScoringConfig = scoringConfig
): number {
  if (count <= 0) return 0
  const score = (count / cfg.maxAttestationCount) * cfg.attestationScoreMax
  return Math.min(cfg.attestationScoreMax, Math.round(score))
}

/** Compute a full TrustScore from an Identity record. */
export function computeTrustScore(
  identity: Identity,
  cfg: ScoringConfig = scoringConfig
): TrustScore {
  const bondScore = computeBondScore(identity.bondedAmount, cfg)
  const durationScore = computeDurationScore(identity.bondStart, Date.now(), cfg)
  const attestationScore = computeAttestationScore(identity.attestationCount, cfg)
  const score = Math.min(100, bondScore + durationScore + attestationScore)

  return {
    address: identity.address,
    score,
    bondedAmount: identity.bondedAmount,
    bondStart: identity.bondStart,
    attestationCount: identity.attestationCount,
    scoringModelVersion: cfg.scoringModelVersion,
    ...(identity.agreedFields ? { agreedFields: identity.agreedFields } : {}),
  }
}

/**
 * Look up an identity by address and return its computed trust score,
 * or null when no record exists.
 */
export function getTrustScore(address: string): TrustScore | null {
  const identity = getIdentity(address)
  if (!identity) return null
  return computeTrustScore(identity)
}
