import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createHealthRouter } from '../../src/routes/health.js'

function appWithHealth(probes: Parameters<typeof createHealthRouter>[0] = {}) {
  const app = express()
  app.use('/api/health', createHealthRouter(probes))
  return app
}

describe('Health route – dependency-aware checks with degradation reasons', () => {
  it('includes reason when db is down', async () => {
    const app = appWithHealth({
      db: async () => ({ status: 'down', reason: 'connection_refused' }),
      cache: async () => ({ status: 'up' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('unhealthy')
    expect(res.body.dependencies.db.status).toBe('down')
    expect(res.body.dependencies.db.reason).toBe('connection_refused')
  })

  it('includes reason when cache is down', async () => {
    const app = appWithHealth({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'down', reason: 'timeout' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.dependencies.cache.reason).toBe('timeout')
  })

  it('includes reason when queue is down', async () => {
    const app = appWithHealth({
      queue: async () => ({ status: 'down', reason: 'connection_refused' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.dependencies.queue.reason).toBe('connection_refused')
  })

  it('includes reason when gateway is down (degraded)', async () => {
    const app = appWithHealth({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'up' }),
      gateway: async () => ({ status: 'down', reason: 'unhealthy_response' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('degraded')
    expect(res.body.dependencies.gateway.reason).toBe('unhealthy_response')
  })

  it('omits reason when dependency is up', async () => {
    const app = appWithHealth({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'up' }),
    })
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.dependencies.db.reason).toBeUndefined()
    expect(res.body.dependencies.cache.reason).toBeUndefined()
  })

  it('schema is stable: always has status, service, dependencies keys', async () => {
    const app = appWithHealth({})
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('status')
    expect(res.body).toHaveProperty('service', 'credence-backend')
    expect(res.body).toHaveProperty('dependencies')
    expect(res.body.dependencies).toHaveProperty('db')
    expect(res.body.dependencies).toHaveProperty('cache')
    expect(res.body.dependencies).toHaveProperty('queue')
    expect(res.body.dependencies).toHaveProperty('gateway')
  })

  it('/ready also propagates reason', async () => {
    const app = appWithHealth({
      db: async () => ({ status: 'down', reason: 'timeout' }),
    })
    const res = await request(app).get('/api/health/ready')
    expect(res.status).toBe(503)
    expect(res.body.dependencies.db.reason).toBe('timeout')
  })

  it('/live never includes dependency details', async () => {
    const app = appWithHealth({
      db: async () => ({ status: 'down', reason: 'connection_refused' }),
    })
    const res = await request(app).get('/api/health/live')
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('dependencies')
  })
})
