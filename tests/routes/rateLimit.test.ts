/**
 * @file Integration tests for tenant-level rate limiting.
 *
 * Covers:
 * ─ Response headers on every request
 * ─ 429 when limit exceeded
 * ─ Tenant isolation (different tenants do not share counters)
 * ─ Tier-based limits (free vs pro vs enterprise)
 * ─ Fail-open when Redis is unavailable
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createRateLimitMiddleware, getTenantId, resolveTierLimit } from '../../src/middleware/rateLimit.js'
import type { Config } from '../../src/config/index.js'
import type { SubscriptionTier } from '../../src/services/apiKeys.js'

// ── In-memory Redis mock ────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, number>()

  async incr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) + 1
    this.store.set(key, next)
    return next
  }

  async expire(_key: string, _seconds: number): Promise<void> {
    // no-op for fixed-window mock
  }

  async ttl(key: string): Promise<number> {
    return this.store.has(key) ? 60 : -1
  }

  reset() {
    this.store.clear()
  }
}

const mockRedis = new MockRedis()

// Mock the RedisConnection singleton before importing route modules
vi.mock('../../src/cache/redis.js', () => ({
  RedisConnection: {
    getInstance: () => ({
      getClient: () => mockRedis,
    }),
  },
}))

// ── Helpers ─────────────────────────────────────────────────────────────

function buildApp(opts: {
  max?: number
  windowSec?: number
  enabled?: boolean
  failOpen?: boolean
  getTenantId?: (req: express.Request) => string | undefined
} = {}): Express {
  const config: Config['rateLimit'] = {
    enabled: opts.enabled ?? true,
    windowSec: opts.windowSec ?? 60,
    maxFree: opts.max ?? 3,
    maxPro: opts.max ?? 3,
    maxEnterprise: opts.max ?? 3,
    failOpen: opts.failOpen ?? true,
  }

  const app = express()
  app.use(express.json())
  app.use(
    '/api',
    createRateLimitMiddleware(config, {
      namespace: 'ratelimit:test',
      windowSec: opts.windowSec ?? 60,
      max: opts.max,
      getTenantId: opts.getTenantId,
    })
  )
  app.get('/api/ping', (_req, res) => res.json({ ok: true }))
  app.post('/api/ping', (_req, res) => res.json({ ok: true }))
  app.use((_err: any, _req: any, res: any, _next: any) => {
    res.status(_err.status ?? 500).json({
      error: _err.message,
      code: _err.code,
      details: _err.details,
    })
  })
  return app
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Rate Limit Middleware', () => {
  beforeEach(() => {
    mockRedis.reset()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Headers
  // ═══════════════════════════════════════════════════════════════════════

  describe('response headers', () => {
    it('should include X-RateLimit-* headers on a successful request', async () => {
      const app = buildApp({ max: 5 })
      const res = await request(app).get('/api/ping')

      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBe('5')
      expect(res.headers['x-ratelimit-remaining']).toBe('4')
      expect(res.headers['x-ratelimit-reset']).toBeDefined()
    })

    it('should decrement remaining with each request', async () => {
      const app = buildApp({ max: 5 })

      const r1 = await request(app).get('/api/ping')
      expect(r1.headers['x-ratelimit-remaining']).toBe('4')

      const r2 = await request(app).get('/api/ping')
      expect(r2.headers['x-ratelimit-remaining']).toBe('3')
    })

    it('should include Retry-After on 429', async () => {
      const app = buildApp({ max: 1 })

      await request(app).get('/api/ping') // consume the single request
      const res = await request(app).get('/api/ping')

      expect(res.status).toBe(429)
      expect(res.headers['retry-after']).toBeDefined()
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Limit enforcement
  // ═══════════════════════════════════════════════════════════════════════

  describe('limit enforcement', () => {
    it('should return 429 when the limit is exceeded', async () => {
      const app = buildApp({ max: 2 })

      const r1 = await request(app).get('/api/ping')
      expect(r1.status).toBe(200)

      const r2 = await request(app).get('/api/ping')
      expect(r2.status).toBe(200)

      const r3 = await request(app).get('/api/ping')
      expect(r3.status).toBe(429)
      expect(r3.body.error).toMatch(/rate limit exceeded/i)
      expect(r3.body.details).toMatchObject({ limit: 2 })
    })

    it('should reset after the window (new counter)', async () => {
      // Because our mock uses a single Map and does not expire keys,
      // we simulate a reset by clearing the store between batches.
      const app = buildApp({ max: 1 })

      const r1 = await request(app).get('/api/ping')
      expect(r1.status).toBe(200)

      const r2 = await request(app).get('/api/ping')
      expect(r2.status).toBe(429)

      mockRedis.reset()

      const r3 = await request(app).get('/api/ping')
      expect(r3.status).toBe(200)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ═══════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('should track limits per tenant independently', async () => {
      const app = buildApp({
        max: 2,
        getTenantId: (req) => (req.headers['x-tenant'] as string) ?? undefined,
      })

      // Tenant A consumes 2 requests
      await request(app).get('/api/ping').set('x-tenant', 'tenant-a')
      await request(app).get('/api/ping').set('x-tenant', 'tenant-a')

      // Tenant A is now blocked
      const blocked = await request(app).get('/api/ping').set('x-tenant', 'tenant-a')
      expect(blocked.status).toBe(429)

      // Tenant B should still be allowed
      const allowed = await request(app).get('/api/ping').set('x-tenant', 'tenant-b')
      expect(allowed.status).toBe(200)
    })

    it('should fall back to IP when no tenant is identified', async () => {
      const app = buildApp({ max: 1 })

      const r1 = await request(app).get('/api/ping')
      expect(r1.status).toBe(200)

      // Same "IP" in supertest (default) should be blocked
      const r2 = await request(app).get('/api/ping')
      expect(r2.status).toBe(429)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Tier-based limits
  // ═══════════════════════════════════════════════════════════════════════

  describe('tier-based limits', () => {
    it('resolveTierLimit returns correct defaults', () => {
      const config: Config['rateLimit'] = {
        enabled: true,
        windowSec: 60,
        maxFree: 10,
        maxPro: 50,
        maxEnterprise: 200,
        failOpen: true,
      }

      expect(resolveTierLimit('free', config)).toBe(10)
      expect(resolveTierLimit('pro', config)).toBe(50)
      expect(resolveTierLimit('enterprise', config)).toBe(200)
    })

    it('should use tier from req.apiKeyRecord when present', async () => {
      const config: Config['rateLimit'] = {
        enabled: true,
        windowSec: 60,
        maxFree: 1,
        maxPro: 5,
        maxEnterprise: 10,
        failOpen: true,
      }

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as any).apiKeyRecord = { ownerId: 'owner-1', tier: 'pro' as SubscriptionTier }
        next()
      })
      app.use('/api', createRateLimitMiddleware(config, { namespace: 'ratelimit:tier' }))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message })
      })

      // Pro tier allows 5 requests
      for (let i = 0; i < 5; i++) {
        const r = await request(app).get('/api/ping')
        expect(r.status).toBe(200)
      }

      const blocked = await request(app).get('/api/ping')
      expect(blocked.status).toBe(429)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Fail-open
  // ═══════════════════════════════════════════════════════════════════════

  describe('fail-open behavior', () => {
    it('should allow traffic when Redis throws and failOpen is true', async () => {
      const brokenRedis = {
        incr: vi.fn().mockRejectedValue(new Error('Redis down')),
        expire: vi.fn(),
        ttl: vi.fn(),
      }

      vi.doMock('../../src/cache/redis.js', () => ({
        RedisConnection: {
          getInstance: () => ({ getClient: () => brokenRedis }),
        },
      }))

      // Re-import to pick up the mocked Redis
      const { createRateLimitMiddleware: createWithBrokenRedis } = await import(
        '../../src/middleware/rateLimit.js'
      )

      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createWithBrokenRedis({
          enabled: true,
          windowSec: 60,
          maxFree: 1,
          maxPro: 1,
          maxEnterprise: 1,
          failOpen: true,
        })
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBeDefined()
      expect(res.headers['x-ratelimit-remaining']).toBeDefined()
    })

    it('should return 503 when Redis throws and failOpen is false', async () => {
      const brokenRedis = {
        incr: vi.fn().mockRejectedValue(new Error('Redis down')),
        expire: vi.fn(),
        ttl: vi.fn(),
      }

      vi.doMock('../../src/cache/redis.js', () => ({
        RedisConnection: {
          getInstance: () => ({ getClient: () => brokenRedis }),
        },
      }))

      const { createRateLimitMiddleware: createWithBrokenRedis } = await import(
        '../../src/middleware/rateLimit.js'
      )

      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createWithBrokenRedis({
          enabled: true,
          windowSec: 60,
          maxFree: 1,
          maxPro: 1,
          maxEnterprise: 1,
          failOpen: false,
        })
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code })
      })

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(503)
      expect(res.body.error).toMatch(/unavailable/i)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // getTenantId helper
  // ═══════════════════════════════════════════════════════════════════════

  describe('getTenantId', () => {
    it('should prefer apiKeyRecord.ownerId', () => {
      const req = { apiKeyRecord: { ownerId: 'owner-1' } } as any
      expect(getTenantId(req)).toBe('owner-1')
    })

    it('should fall back to user.tenantId', () => {
      const req = { user: { tenantId: 'tenant-1' } } as any
      expect(getTenantId(req)).toBe('tenant-1')
    })

    it('should hash x-api-key when no auth record is present', () => {
      const req = { headers: { 'x-api-key': 'secret-key-123' } } as any
      const id = getTenantId(req)
      expect(id).toMatch(/^ak:/)
      expect(id).not.toContain('secret')
    })

    it('should hash Bearer token when no auth record is present', () => {
      const req = { headers: { authorization: 'Bearer my-token-456' } } as any
      const id = getTenantId(req)
      expect(id).toMatch(/^bt:/)
      expect(id).not.toContain('my-token')
    })

    it('should return undefined when nothing is present', () => {
      const req = { headers: {} } as any
      expect(getTenantId(req)).toBeUndefined()
    })
  })
})

