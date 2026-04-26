import { describe, it, expect, vi } from 'vitest'

// Mock prom-client BEFORE importing modules that use it
vi.mock('prom-client', () => ({
  default: {
    Summary: class MockSummary {
      constructor(public config: any) {}
      observe(labels: any, value: number) {}
      reset() {}
      get() { return { values: [] } }
    },
    Registry: class MockRegistry {
      registerMetric(metric: any) {}
    }
  }
}))

import * as observability from '../observability/index'

describe('observability module exports', () => {
  it('exports latency metrics utilities', () => {
    expect(observability.normalizeRoute).toBeDefined()
    expect(observability.httpLatencyPercentiles).toBeDefined()
    expect(observability.registerLatencyMetrics).toBeDefined()
  })

  it('exports timeout metrics utilities', () => {
    expect(observability.ConsoleTimeoutMetrics).toBeDefined()
    expect(observability.ProductionTimeoutMetrics).toBeDefined()
    expect(observability.createDefaultMetricsCollector).toBeDefined()
    expect(observability.createTimeoutEvent).toBeDefined()
    expect(observability.createSlowOperationEvent).toBeDefined()
    expect(observability.createSuccessEvent).toBeDefined()
  })

  it('normalizeRoute function works', () => {
    const result = observability.normalizeRoute('/api/trust/0x123', '/api/trust/:address')
    expect(result).toBe('/api/trust/:address')
  })

  it('creates timeout metrics collector', () => {
    const collector = observability.createDefaultMetricsCollector()
    expect(collector).toBeDefined()
    expect(collector.onTimeout).toBeDefined()
    expect(collector.onSlowOperation).toBeDefined()
    expect(collector.onSuccess).toBeDefined()
  })
})
