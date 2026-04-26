import { describe, it, expect } from 'vitest'

// Test route normalization logic directly without importing the full module
function normalizeRoute(path: string, routePath?: string): string {
  if (routePath) return routePath
  
  return path
    .replace(/\/0x[a-fA-F0-9]+/g, '/:address')
    .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
}

describe('latencyMetrics - route normalization', () => {
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
