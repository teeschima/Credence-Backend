/**
 * Middleware for tracking percentile latency metrics.
 * 
 * Integrates with Express to record p50, p95, p99 latencies
 * using safe route templates to prevent cardinality explosion.
 */

import { Request, Response, NextFunction } from 'express'
import { httpLatencyPercentiles, normalizeRoute } from '../observability/latencyMetrics.js'

/**
 * Express middleware to track HTTP request latency percentiles.
 * 
 * Usage:
 * ```typescript
 * import { latencyMetricsMiddleware } from './middleware/latencyMetrics.js'
 * app.use(latencyMetricsMiddleware)
 * ```
 */
export function latencyMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint()
  
  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - start
    const durationSeconds = Number(durationNs) / 1e9
    
    const route = normalizeRoute(req.path, req.route?.path)
    
    httpLatencyPercentiles.observe(
      {
        method: req.method,
        route,
        status: res.statusCode.toString(),
      },
      durationSeconds
    )
  })
  
  next()
}
