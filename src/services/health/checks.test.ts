import { describe, it, expect } from 'vitest'
import { runHealthChecks } from './checks.js'

describe('runHealthChecks', () => {
  it('returns degraded when no probes are configured (all not_configured)', async () => {
    const result = await runHealthChecks({})
    expect(result.status).toBe('degraded')
    expect(result.service).toBe('credence-backend')
    expect(result.dependencies.postgres).toEqual({ status: 'not_configured' })
    expect(result.dependencies.redis).toEqual({ status: 'not_configured' })
    expect(result.dependencies.horizonListener).toEqual({ status: 'not_configured' })
    expect(result.dependencies.outboxPublisher).toEqual({ status: 'not_configured' })
  })

  it('returns ok when postgres, redis, horizon listener, and outbox are up', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('ok')
    expect(result.dependencies.postgres).toEqual({ status: 'up' })
    expect(result.dependencies.redis).toEqual({ status: 'up' })
    expect(result.dependencies.horizonListener).toEqual({ status: 'up' })
    expect(result.dependencies.outboxPublisher).toEqual({ status: 'up' })
  })

  it('returns unhealthy when postgres is down', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'down' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.postgres).toEqual({ status: 'down' })
    expect(result.dependencies.redis).toEqual({ status: 'up' })
  })

  it('returns unhealthy when redis is down', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'down' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.redis).toEqual({ status: 'down' })
  })

  it('returns unhealthy when horizon listener is down', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'down', reason: 'stale_heartbeat' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.horizonListener).toEqual({ status: 'down', reason: 'stale_heartbeat' })
  })

  it('returns unhealthy when outbox publisher is down', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'down', reason: 'not_running' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.outboxPublisher).toEqual({ status: 'down', reason: 'not_running' })
  })

  it('returns degraded when any dependency is not configured', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'not_configured' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('degraded')
    expect(result.dependencies.horizonListener).toEqual({ status: 'not_configured' })
  })

  it('does not expose internal details in response', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'down' }),
      redis: async () => ({ status: 'down' }),
      horizonListener: async () => ({ status: 'down' }),
      outboxPublisher: async () => ({ status: 'down' }),
    })
    const body = JSON.stringify(result)
    expect(body).not.toMatch(/error|message|stack|connection|url|host/i)
    expect(result.dependencies.postgres).toEqual({ status: 'down' })
    expect(Object.keys(result.dependencies.postgres)).toEqual(['status'])
  })
})
