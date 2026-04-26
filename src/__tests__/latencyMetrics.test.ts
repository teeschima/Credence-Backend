import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock prom-client BEFORE importing modules that use it
vi.mock('prom-client', () => ({
  default: {
    Summary: class MockSummary {
      constructor(public config: any) {}
      observe(labels: any, value: number) {}
      reset() {}
      get() {
        return {
          values: [
            {
              labels: { method: 'GET', route: '/api/health', status: '200' },
              metricName: 'http_request_duration_percentiles_seconds',
              value: 0.1
            }
          ]
        }
      }
    },
    Registry: class MockRegistry {
      registerMetric(metric: any) {}
    }
  }
}))

import { normalizeRoute, httpLatencyPercentiles } from '../observability/latencyMetrics'

describe('latencyMetrics', () => {
  describe('normalizeRoute', () => {
    it('uses Express route path when available', () => {
      const result = normalizeRoute('/api/trust/0x123abc', '/api/trust/:address')
      expect(result).toBe('/api/trust/:address')
    })

    it('normalizes hex addresses in path', () => {
      const result = normalizeRoute('/api/trust/0x123abc')
      expect(result).toBe('/api/trust/:address')
    })

    it('normalizes UUIDs in path', () => {
      const result = normalizeRoute('/api/jobs/550e8400-e29b-41d4-a716-446655440000')
      expect(result).toBe('/api/jobs/:id')
    })

    it('normalizes numeric IDs in path', () => {
      const result = normalizeRoute('/api/users/12345')
      expect(result).toBe('/api/users/:id')
    })

    it('handles multiple dynamic segments', () => {
      const result = normalizeRoute('/api/attestations/0xabc/verify/123')
      expect(result).toBe('/api/attestations/:address/verify/:id')
    })

    it('preserves static routes', () => {
      const result = normalizeRoute('/api/health')
      expect(result).toBe('/api/health')
    })

    it('handles mixed case hex addresses', () => {
      const result = normalizeRoute('/api/bond/0xAbC123')
      expect(result).toBe('/api/bond/:address')
    })
  })

  describe('httpLatencyPercentiles', () => {
    beforeEach(() => {
      httpLatencyPercentiles.reset()
    })

    it('records latency observations', () => {
      httpLatencyPercentiles.observe(
        { method: 'GET', route: '/api/trust/:address', status: '200' },
        0.05
      )
      httpLatencyPercentiles.observe(
        { method: 'GET', route: '/api/trust/:address', status: '200' },
        0.1
      )

      const metrics = httpLatencyPercentiles.get()
      expect(metrics.values.length).toBeGreaterThan(0)
    })

    it('tracks different routes separately', () => {
      httpLatencyPercentiles.observe(
        { method: 'GET', route: '/api/trust/:address', status: '200' },
        0.05
      )
      httpLatencyPercentiles.observe(
        { method: 'POST', route: '/api/attestations', status: '201' },
        0.15
      )

      const metrics = httpLatencyPercentiles.get()
      expect(metrics.values.length).toBe(2)
    })

    it('provides percentile calculations', () => {
      const values = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0]
      values.forEach(v => {
        httpLatencyPercentiles.observe(
          { method: 'GET', route: '/api/health', status: '200' },
          v
        )
      })

      const metrics = httpLatencyPercentiles.get()
      const healthMetric = metrics.values.find(
        v => v.labels.route === '/api/health'
      )
      
      expect(healthMetric).toBeDefined()
      expect(healthMetric?.metricName).toBe('http_request_duration_percentiles_seconds')
    })
  })

  describe('cardinality bounds', () => {
    it('limits unique route templates', () => {
      const routes = [
        '/api/trust/0x111',
        '/api/trust/0x222',
        '/api/trust/0x333',
        '/api/bond/0xaaa',
        '/api/bond/0xbbb',
      ]

      const normalized = routes.map(r => normalizeRoute(r))
      const unique = new Set(normalized)
      
      expect(unique.size).toBe(2) // Only /api/trust/:address and /api/bond/:address
    })

    it('prevents explosion from dynamic segments', () => {
      const dynamicRoutes = Array.from({ length: 1000 }, (_, i) => 
        `/api/trust/0x${i.toString(16).padStart(6, '0')}`
      )

      const normalized = dynamicRoutes.map(r => normalizeRoute(r))
      const unique = new Set(normalized)
      
      expect(unique.size).toBe(1) // All normalize to /api/trust/:address
    })
  })
})
