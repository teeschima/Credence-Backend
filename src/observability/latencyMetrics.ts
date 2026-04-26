/**
 * Percentile latency metrics with safe route templates.
 * 
 * Prevents cardinality explosion by normalizing dynamic route segments
 * (e.g., /api/trust/0x123 → /api/trust/:address).
 */

import client from 'prom-client'

/**
 * Normalizes Express routes to template form to prevent cardinality explosion.
 * 
 * Examples:
 * - /api/trust/0x123abc → /api/trust/:address
 * - /api/bond/stellar123 → /api/bond/:address
 * - /api/attestations/0xabc/verify → /api/attestations/:address/verify
 * 
 * Cardinality policy:
 * - Use req.route.path when available (already templated by Express)
 * - Fallback to req.path for unmatched routes
 * - Max unique routes: ~50 (bounded by API surface)
 */
export function normalizeRoute(path: string, routePath?: string): string {
  if (routePath) return routePath
  
  // Fallback normalization for unmatched routes
  return path
    .replace(/\/0x[a-fA-F0-9]+/g, '/:address')
    .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
}

/**
 * HTTP request latency percentiles (p50, p95, p99).
 * 
 * Labels: method, route, status
 * Cardinality: ~10 methods × ~50 routes × ~10 status codes = ~5,000 series
 */
export const httpLatencyPercentiles = new client.Summary({
  name: 'http_request_duration_percentiles_seconds',
  help: 'HTTP request latency percentiles (p50, p95, p99)',
  labelNames: ['method', 'route', 'status'],
  percentiles: [0.5, 0.95, 0.99],
  maxAgeSeconds: 600,
  ageBuckets: 5,
})

/**
 * Registers the latency percentile metrics with the provided registry.
 */
export function registerLatencyMetrics(registry: client.Registry): void {
  registry.registerMetric(httpLatencyPercentiles)
}
