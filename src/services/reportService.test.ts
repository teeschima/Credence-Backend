import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReportService } from './reportService.js'
import { ReportRepository } from '../db/repositories/reportRepository.js'
import { ReportJobStatus } from '../jobs/types.js'
import { cache } from '../cache/redis.js'
import * as invalidation from '../cache/invalidation.js'

vi.mock('../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('../cache/invalidation.js', async () => {
  const actual = await vi.importActual('../cache/invalidation.js')
  return {
    ...actual,
    invalidateCache: vi.fn()
  }
})

describe('ReportService', () => {
  let reportService: ReportService
  let mockReportRepository: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockReportRepository = {
      create: vi.fn(),
      findById: vi.fn(),
      updateStatus: vi.fn(),
    }
    reportService = new ReportService(mockReportRepository as unknown as ReportRepository)
  })

  describe('startReportGeneration', () => {
    it('should create a job in queued status and return it', async () => {
      const mockJob = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.QUEUED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      mockReportRepository.create.mockResolvedValue(mockJob)

      const job = await reportService.startReportGeneration('test-report')

      expect(job).toEqual(mockJob)
      expect(mockReportRepository.create).toHaveBeenCalledWith('test-report')
    })

    it('should trigger background processing', async () => {
      const mockJob = { id: 'job-123', type: 'test-report', status: ReportJobStatus.QUEUED }
      mockReportRepository.create.mockResolvedValue(mockJob)
      
      // Spy on processReport (private method)
      const processSpy = vi.spyOn(reportService as any, 'processReport')

      await reportService.startReportGeneration('test-report')

      expect(processSpy).toHaveBeenCalledWith('job-123')
    })
  })

  describe('getReportStatus', () => {
    it('should return cached report if available', async () => {
      const mockJob = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.RUNNING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      vi.mocked(cache.get).mockResolvedValue(mockJob)

      const result = await reportService.getReportStatus('job-123')

      expect(cache.get).toHaveBeenCalledWith('report', 'job-123')
      expect(mockReportRepository.findById).not.toHaveBeenCalled()
      expect(result).toEqual(mockJob)
    })

    it('should fetch from repository and cache if not in cache', async () => {
      const mockJob = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.COMPLETED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      vi.mocked(cache.get).mockResolvedValue(null)
      mockReportRepository.findById.mockResolvedValue(mockJob)

      const result = await reportService.getReportStatus('job-123')

      expect(mockReportRepository.findById).toHaveBeenCalledWith('job-123')
      expect(cache.set).toHaveBeenCalledWith('report', 'job-123', mockJob, 300)
      expect(result).toEqual(mockJob)
    })
  })

  describe('processReport (background logic)', () => {
    it('should transition status from QUEUED -> RUNNING -> COMPLETED', async () => {
      const jobId = 'job-123'
      const mockJob = { id: jobId, status: ReportJobStatus.COMPLETED }
      
      // Mock updateStatus and findById to return a job
      mockReportRepository.updateStatus.mockResolvedValue(undefined)
      mockReportRepository.findById.mockResolvedValue(mockJob)

      // Use a shorter timeout for testing if possible, or mock timers
      vi.useFakeTimers()

      const processPromise = (reportService as any).processReport(jobId)

      // Should have called RUNNING status
      expect(mockReportRepository.updateStatus).toHaveBeenCalledWith(jobId, ReportJobStatus.RUNNING, undefined)

      // Fast-forward timers
      await vi.runAllTimersAsync()
      await processPromise

      // Should have called COMPLETED status with artifact URL
      expect(mockReportRepository.updateStatus).toHaveBeenCalledWith(
        jobId,
        ReportJobStatus.COMPLETED,
        expect.objectContaining({
          artifactUrl: expect.stringContaining(jobId),
        })
      )

      // Verify cache invalidation was called
      expect(invalidation.invalidateCache).toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('should transition to FAILED if an error occurs', async () => {
      const jobId = 'job-123'
      const mockJob = { id: jobId, status: ReportJobStatus.FAILED }
      mockReportRepository.updateStatus.mockRejectedValueOnce(new Error('DB Error'))
      mockReportRepository.findById.mockResolvedValue(mockJob)

      await (reportService as any).processReport(jobId)

      expect(mockReportRepository.updateStatus).toHaveBeenCalledWith(
        jobId,
        ReportJobStatus.FAILED,
        expect.objectContaining({
          failureReason: 'INTERNAL_ERROR',
        })
      )
    })
  })
})
