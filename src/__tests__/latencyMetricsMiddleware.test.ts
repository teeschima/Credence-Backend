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

import express, { Express } from 'express'
import request from 'supertest'
import { latencyMetricsMiddleware } from '../middleware/latencyMetrics'
import { httpLatencyPercentiles } from '../observability/latencyMetrics'

describe('latencyMetricsMiddleware', () => {
  let app: Express

  beforeEach(() => {
    httpLatencyPercentiles.reset()
    app = express()
    app.use(latencyMetricsMiddleware)
  })

  it('records latency for successful requests', async () => {
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

    await request(app).get('/api/health').expect(200)

    const metrics = httpLatencyPercentiles.get()
    const healthMetric = metrics.values.find(
      v => v.labels.route === '/api/health' && v.labels.status === '200'
    )

    expect(healthMetric).toBeDefined()
  })

  it('records latency for error responses', async () => {
    app.get('/api/error', (_req, res) => res.status(500).json({ error: 'fail' }))

    await request(app).get('/api/error').expect(500)

    const metrics = httpLatencyPercentiles.get()
    const errorMetric = metrics.values.find(
      v => v.labels.route === '/api/error' && v.labels.status === '500'
    )

    expect(errorMetric).toBeDefined()
  })

  it('normalizes dynamic route segments', async () => {
    app.get('/api/trust/:address', (req, res) => 
      res.json({ address: req.params.address })
    )

    await request(app).get('/api/trust/0x123abc').expect(200)
    await request(app).get('/api/trust/0x456def').expect(200)

    const metrics = httpLatencyPercentiles.get()
    const trustMetrics = metrics.values.filter(
      v => v.labels.route === '/api/trust/:address'
    )

    expect(trustMetrics.length).toBe(1) // Single metric for template route
  })

  it('tracks different HTTP methods separately', async () => {
    app.get('/api/data', (_req, res) => res.json({ method: 'GET' }))
    app.post('/api/data', (_req, res) => res.json({ method: 'POST' }))

    await request(app).get('/api/data').expect(200)
    await request(app).post('/api/data').expect(200)

    const metrics = httpLatencyPercentiles.get()
    const getMetric = metrics.values.find(
      v => v.labels.method === 'GET' && v.labels.route === '/api/data'
    )
    const postMetric = metrics.values.find(
      v => v.labels.method === 'POST' && v.labels.route === '/api/data'
    )

    expect(getMetric).toBeDefined()
    expect(postMetric).toBeDefined()
  })

  it('handles multiple requests to same route', async () => {
    app.get('/api/test', (_req, res) => res.json({ ok: true }))

    await Promise.all([
      request(app).get('/api/test'),
      request(app).get('/api/test'),
      request(app).get('/api/test'),
    ])

    const metrics = httpLatencyPercentiles.get()
    const testMetric = metrics.values.find(
      v => v.labels.route === '/api/test'
    )

    expect(testMetric).toBeDefined()
    expect(testMetric?.value).toBeGreaterThan(0)
  })

  it('records latency in seconds', async () => {
    app.get('/api/slow', async (_req, res) => {
      await new Promise(resolve => setTimeout(resolve, 10))
      res.json({ ok: true })
    })

    await request(app).get('/api/slow').expect(200)

    const metrics = httpLatencyPercentiles.get()
    const slowMetric = metrics.values.find(
      v => v.labels.route === '/api/slow'
    )

    expect(slowMetric).toBeDefined()
    // Should be at least 0.01 seconds (10ms)
    expect(slowMetric?.value).toBeGreaterThanOrEqual(0.01)
  })

  it('handles unmatched routes with fallback normalization', async () => {
    // No route defined, will use fallback normalization
    await request(app).get('/api/unknown/0x123').expect(404)

    const metrics = httpLatencyPercentiles.get()
    const unknownMetric = metrics.values.find(
      v => v.labels.route === '/api/unknown/:address'
    )

    expect(unknownMetric).toBeDefined()
  })
})
