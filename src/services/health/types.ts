/**
 * Health check result for a single dependency.
 * Status is intentionally minimal to avoid exposing internal details.
 */
export type DependencyStatus = 'up' | 'down' | 'not_configured'

export interface DependencyHealth {
  status: DependencyStatus
  /** Human-readable reason for non-'up' status. Omitted when status is 'up'. */
  reason?: string
  /** Optional safe metadata for debugging readiness (no secrets). */
  details?: Record<string, string | number | boolean | null>
}

export interface HealthResult {
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  dependencies: {
    postgres: DependencyHealth
    redis: DependencyHealth
    horizonListener: DependencyHealth
    outboxPublisher: DependencyHealth
  }
}

/** Injectable probe: returns dependency status without exposing internals. */
export type HealthProbe = () => Promise<DependencyHealth>
