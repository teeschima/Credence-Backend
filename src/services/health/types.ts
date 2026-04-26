/**
 * Health check result for a single dependency.
 * Status is intentionally minimal to avoid exposing internal details.
 */
export type DependencyStatus = 'up' | 'down' | 'not_configured'

export interface DependencyHealth {
  status: DependencyStatus
  /** Human-readable reason for non-'up' status. Omitted when status is 'up'. */
  reason?: string
}

export interface HealthResult {
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  dependencies: {
    db: DependencyHealth
    cache: DependencyHealth
    queue: DependencyHealth
    gateway: DependencyHealth
  }
}

/** Injectable probe: returns dependency status without exposing internals. */
export type HealthProbe = () => Promise<DependencyHealth>
