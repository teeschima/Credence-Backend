import 'dotenv/config'
import { initTracing } from './tracing/tracer.js'
import app from './app.js'
import { createAdminRouter } from './routes/admin/index.js'
import governanceRouter from './routes/governance.js'
import disputesRouter from './routes/disputes.js'
import evidenceRouter from './routes/evidence.js'
import { loadConfig } from './config/index.js'
import { pool } from './db/pool.js'
import { AnalyticsService } from './services/analytics/service.js'
import { AnalyticsRefreshWorker, getAnalyticsRefreshIntervalMs } from './jobs/analyticsRefreshWorker.js'
import { AnalyticsRefreshScheduler } from './jobs/analyticsRefreshScheduler.js'
import { createAnalyticsRefreshMetrics } from './jobs/analyticsRefreshMetrics.js'
import { keyManager } from './services/keyManager/index.js'

app.use('/api/admin', createAdminRouter())
app.use('/api/governance', governanceRouter)
app.use('/api/disputes', disputesRouter)
app.use('/api/evidence', evidenceRouter)
export { app }
export default app

if (process.env.NODE_ENV !== 'test') {
  initTracing()

  try {
    const config = loadConfig()

    app.listen(config.port, () => {
      console.log(`Credence API listening on port ${config.port}`)
    })

    if (process.env.DATABASE_URL) {
      const thresholdSeconds = Number(process.env.ANALYTICS_STALENESS_SECONDS ?? '300')
      const analyticsService = new AnalyticsService(pool, thresholdSeconds)
      const metrics = createAnalyticsRefreshMetrics()
      const refreshWorker = new AnalyticsRefreshWorker(analyticsService, console.log, metrics)
      const intervalMs = getAnalyticsRefreshIntervalMs()

      const scheduler = new AnalyticsRefreshScheduler(refreshWorker, {
        intervalMs,
        runOnStart: true,
        logger: console.log,
        metrics,
      })

      scheduler.start()
    }
  } catch (error) {
    console.error('Failed to start Credence API:', error)
    process.exit(1)
  }
}
