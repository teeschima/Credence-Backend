import express from 'express'
import { createJwksRouter } from './routes/jwks.js'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'
import trustRouter from './routes/trust.js'
import bulkRouter from './routes/bulk.js'
import importsRouter from './routes/imports.js'
import { createAdminRouter } from './routes/admin/index.js'
import { createWebhookAdminRouter } from './routes/admin/webhooks.js'
import { createPolicyRouter } from './routes/policy.js'
import { createAnalyticsRouter } from './routes/analytics.js'
import { createPayoutsRouter } from './routes/payouts.js'
import { AnalyticsService } from './services/analytics/service.js'
import { pool } from './db/pool.js'
import { validate } from './middleware/validate.js'
import { requestIdMiddleware } from './middleware/requestId.js'
import { errorHandler } from './middleware/errorHandler.js'
import { createRateLimitMiddleware } from './middleware/rateLimit.js'
import { validateConfig } from './config/index.js'
import {
  buildPaginationMeta,
  parsePaginationParams,
} from './lib/pagination.js'
import {
  bondPathParamsSchema,
  attestationsPathParamsSchema,
  createAttestationBodySchema,
} from './schemas/index.js'
import { compressionMiddleware, compressionMetricsMiddleware } from './middleware/compression.js'
import { metricsMiddleware, register } from './middleware/metrics.js'
import { createWebhookAdminRouter } from './routes/admin/webhooks.js'
import { errorHandler } from './middleware/errorHandler.js'

const app = express()

// Load config safely; fall back to defaults if env is incomplete (e.g. in tests)
let rateLimitConfig: { enabled: boolean; windowSec: number; maxFree: number; maxPro: number; maxEnterprise: number; failOpen: boolean }
try {
  rateLimitConfig = validateConfig(process.env).rateLimit
} catch {
  rateLimitConfig = {
    enabled: true,
    windowSec: 60,
    maxFree: 100,
    maxPro: 1000,
    maxEnterprise: 10000,
    failOpen: true,
  }
}

const rateLimitMiddleware = createRateLimitMiddleware(rateLimitConfig)

// Request context and correlation IDs
app.use(requestIdMiddleware)

// Metrics endpoint for Prometheus
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

app.use(metricsMiddleware)
app.use(latencyMetricsMiddleware)
app.use(compressionMetricsMiddleware)
app.use(compressionMiddleware)
app.use(express.json())

// JWT public key set — unauthenticated, per RFC 8414 / OIDC Discovery conventions
app.use('/.well-known/jwks.json', createJwksRouter())

// Health – full readiness check with per-dependency status
const healthProbes = createDefaultProbes()
app.use('/api/health', createHealthRouter(healthProbes))

// Apply tenant-level rate limiting to all API routes below this line.
// Excluded above: metrics, JWKS, health (unauthenticated / infra endpoints).
app.use('/api', rateLimitMiddleware)

// Trust score
app.use('/api/trust', trustRouter)

// Bond status (stub – to be wired to Horizon in a future milestone)
app.get(
  '/api/bond/:address',
  validate({ params: bondPathParamsSchema }),
  (req, res) => {
    const { address } = req.validated!.params! as { address: string }
    res.json({
      address,
      bondedAmount: '0',
      bondStart: null,
      bondDuration: null,
      active: false,
    })
  },
)

// Attestations – list
app.get(
  '/api/attestations/:address',
  validate({ params: attestationsPathParamsSchema }),
  (req, res, next) => {
    const { address } = req.validated!.params! as { address: string }
    try {
      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)
      res.json({
        address,
        attestations: [],
        offset,
        ...buildPaginationMeta(0, page, limit),
      })
    } catch (error) {
      next(error)
    }
  },
)

// Attestations – create
app.post(
  '/api/attestations',
  validate({ body: createAttestationBodySchema }),
  (req, res) => {
    const body = req.validated!.body! as { subject: string; value: string; key?: string }
    res.status(201).json({
      subject: body.subject,
      value: body.value,
      key: body.key ?? null,
    })
  },
)

// Bulk verification (enterprise)
app.use('/api/bulk', bulkRouter)

// Import preview (enterprise)
app.use('/api/imports', importsRouter)

// Admin API
app.use('/api/admin', createAdminRouter())
app.use('/api/admin/webhooks', createWebhookAdminRouter())
app.use('/api/admin/members', createMembersRouter())

// Integration API key management (create, list, rotate, revoke)
app.use('/api/integrations/keys', createApiKeyRouter())

// Policy engine – fine-grained org permissions
app.use('/api/orgs/:orgId/policies', createPolicyRouter())

const analyticsThresholdSeconds = Number(process.env.ANALYTICS_STALENESS_SECONDS ?? '300')
const analyticsService = process.env.DATABASE_URL
  ? new AnalyticsService(pool, analyticsThresholdSeconds)
  : undefined
app.use('/api/analytics', createAnalyticsRouter(analyticsService))

// Payouts
app.use('/api/payouts', createPayoutsRouter())

// Final error handler
app.use(errorHandler)

export default app
