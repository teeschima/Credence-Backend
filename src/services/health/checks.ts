import type { DependencyHealth, HealthProbe } from './types.js'

const SERVICE_NAME = 'credence-backend'

/**
 * Runs all health probes and computes overall status.
 * Returns "unhealthy" when any critical dependency or background worker is down.
 * Returns "degraded" when one or more checks are not configured.
 *
 * @param probes - Object with optional probes for postgres, redis, horizon listener, and outbox publisher
 * @returns Aggregated health result (no internal details exposed)
 */
export async function runHealthChecks(probes: {
  postgres?: HealthProbe
  redis?: HealthProbe
  horizonListener?: HealthProbe
  outboxPublisher?: HealthProbe
}): Promise<{
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  dependencies: {
    postgres: DependencyHealth
    redis: DependencyHealth
    horizonListener: DependencyHealth
    outboxPublisher: DependencyHealth
  }
}> {
  const [postgres, redis, horizonListener, outboxPublisher] = await Promise.all([
    probes.postgres ? probes.postgres() : Promise.resolve({ status: 'not_configured' as const }),
    probes.redis ? probes.redis() : Promise.resolve({ status: 'not_configured' as const }),
    probes.horizonListener
      ? probes.horizonListener()
      : Promise.resolve({ status: 'not_configured' as const }),
    probes.outboxPublisher
      ? probes.outboxPublisher()
      : Promise.resolve({ status: 'not_configured' as const }),
  ])

  const deps = { postgres, redis, horizonListener, outboxPublisher }

  const criticalDown =
    (postgres.status === 'down') ||
    (redis.status === 'down') ||
    (horizonListener.status === 'down') ||
    (outboxPublisher.status === 'down')
  const anyNotConfigured =
    (postgres.status === 'not_configured') ||
    (redis.status === 'not_configured') ||
    (horizonListener.status === 'not_configured') ||
    (outboxPublisher.status === 'not_configured')

  let status: 'ok' | 'degraded' | 'unhealthy'
  if (criticalDown) {
    status = 'unhealthy'
  } else if (anyNotConfigured) {
    status = 'degraded'
  } else {
    status = 'ok'
  }

  return { status, service: SERVICE_NAME, dependencies: deps }
}
