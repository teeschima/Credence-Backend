import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnalyticsRefreshScheduler } from './analyticsRefreshScheduler.js'
import type { AnalyticsRefreshWorker, AnalyticsRefreshWorkerResult } from './analyticsRefreshWorker.js'
import type { DistributedLock } from './distributedLock.js'
import type { AnalyticsRefreshMetrics } from './analyticsRefreshMetrics.js'

const SUCCESS_RESULT: AnalyticsRefreshWorkerResult = {
  refreshed: true,
  duration: 42,
  startTime: '2026-04-25T00:00:00.000Z',
}

function makeWorker(result: AnalyticsRefreshWorkerResult = SUCCESS_RESULT): AnalyticsRefreshWorker {
  return { run: vi.fn().mockResolvedValue(result) } as unknown as AnalyticsRefreshWorker
}

function makeMetrics(): AnalyticsRefreshMetrics {
  return {
    incRuns: vi.fn(),
    observeDuration: vi.fn(),
    setViewAge: vi.fn(),
    incSkip: vi.fn(),
  }
}

describe('AnalyticsRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts and registers an interval', () => {
    const worker = makeWorker()
    const scheduler = new AnalyticsRefreshScheduler(worker, { intervalMs: 5000 })

    scheduler.start()
    expect(scheduler.isActive()).toBe(true)

    scheduler.stop()
    expect(scheduler.isActive()).toBe(false)
  })

  it('does not register a second interval if already started', () => {
    const worker = makeWorker()
    const scheduler = new AnalyticsRefreshScheduler(worker, { intervalMs: 5000 })

    scheduler.start()
    scheduler.start()

    expect(worker.run).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('runs worker on start when runOnStart is true', async () => {
    const worker = makeWorker()
    const scheduler = new AnalyticsRefreshScheduler(worker, {
      intervalMs: 60_000,
      runOnStart: true,
    })

    scheduler.start()
    await vi.runAllTimersAsync()

    expect(worker.run).toHaveBeenCalledOnce()
    scheduler.stop()
  })

  it('runs worker on each interval tick', async () => {
    const worker = makeWorker()
    const scheduler = new AnalyticsRefreshScheduler(worker, { intervalMs: 1000 })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(3100)

    expect(worker.run).toHaveBeenCalledTimes(3)
    scheduler.stop()
  })

  it('skips tick and increments overlap metric when already running', async () => {
    let resolve!: () => void
    const slowWorker = {
      run: vi.fn().mockImplementation(
        () => new Promise<AnalyticsRefreshWorkerResult>((r) => { resolve = () => r(SUCCESS_RESULT) }),
      ),
    } as unknown as AnalyticsRefreshWorker

    const metrics = makeMetrics()
    const scheduler = new AnalyticsRefreshScheduler(slowWorker, {
      intervalMs: 500,
      runOnStart: true,
      metrics,
    })

    scheduler.start()
    // First tick fires (runOnStart) but hasn't resolved yet
    await vi.advanceTimersByTimeAsync(600)
    // Second tick fires while first is still running → should skip
    expect(metrics.incSkip).toHaveBeenCalledWith('overlap')

    resolve()
    scheduler.stop()
  })

  it('skips tick and increments lock_contention metric when distributed lock is held', async () => {
    const worker = makeWorker()
    const metrics = makeMetrics()

    const lock: DistributedLock = {
      withLock: vi.fn().mockResolvedValue({ executed: false }),
      acquire: vi.fn(),
      release: vi.fn(),
      heartbeat: vi.fn(),
      getMetrics: vi.fn().mockReturnValue({ contentions: 1, acquisitions: 0, releases: 0, heartbeats: 0, errors: 0 }),
      resetMetrics: vi.fn(),
    } as unknown as DistributedLock

    const scheduler = new AnalyticsRefreshScheduler(worker, {
      intervalMs: 1000,
      distributedLock: lock,
      metrics,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1100)

    expect(metrics.incSkip).toHaveBeenCalledWith('lock_contention')
    expect(worker.run).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('delegates to worker via distributed lock when lock is acquired', async () => {
    const worker = makeWorker()

    const lock: DistributedLock = {
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<void>) => {
        await fn()
        return { executed: true }
      }),
      acquire: vi.fn(),
      release: vi.fn(),
      heartbeat: vi.fn(),
      getMetrics: vi.fn(),
      resetMetrics: vi.fn(),
    } as unknown as DistributedLock

    const scheduler = new AnalyticsRefreshScheduler(worker, {
      intervalMs: 1000,
      distributedLock: lock,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1100)

    expect(worker.run).toHaveBeenCalledOnce()
    scheduler.stop()
  })

  it('exposes status with run count and last result', async () => {
    const worker = makeWorker()
    const scheduler = new AnalyticsRefreshScheduler(worker, {
      intervalMs: 1000,
      runOnStart: true,
    })

    scheduler.start()
    await vi.runAllTimersAsync()

    const status = scheduler.getStatus()
    expect(status.active).toBe(true)
    expect(status.runCount).toBe(1)
    expect(status.lastResult).toEqual(SUCCESS_RESULT)
    expect(status.isRunning).toBe(false)

    scheduler.stop()
    expect(scheduler.getStatus().active).toBe(false)
  })

  it('uses custom lock key when provided', async () => {
    const worker = makeWorker()
    const lock: DistributedLock = {
      withLock: vi.fn().mockResolvedValue({ executed: true, result: undefined }),
      acquire: vi.fn(),
      release: vi.fn(),
      heartbeat: vi.fn(),
      getMetrics: vi.fn(),
      resetMetrics: vi.fn(),
    } as unknown as DistributedLock

    const scheduler = new AnalyticsRefreshScheduler(worker, {
      intervalMs: 1000,
      distributedLock: lock,
      lockKey: 'custom:analytics-lock',
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1100)

    expect(lock.withLock).toHaveBeenCalledWith(
      'custom:analytics-lock',
      expect.any(Function),
      expect.any(Object),
    )
    scheduler.stop()
  })
})
