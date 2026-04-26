import { ReportRepository } from '../db/repositories/reportRepository.js'
import { ReportJob, ReportJobStatus } from '../jobs/types.js'
import { cache } from '../cache/redis.js'
import { invalidateCache } from '../cache/invalidation.js'

const REPORT_CACHE_TTL = 60 // 1 minute for active jobs

export class ReportService {
  constructor(private readonly reportRepository: ReportRepository) {}

  /**
   * Starts a report generation job asynchronously.
   */
  async startReportGeneration(type: string): Promise<ReportJob> {
    const job = await this.reportRepository.create(type)

    // Run report generation in background
    this.processReport(job.id).catch((error) => {
      console.error(`Error processing report job ${job.id}:`, error)
    })

    return job
  }

  /**
   * Gets the status of a report job with caching.
   */
  async getReportStatus(id: string): Promise<ReportJob | null> {
    const cached = await cache.get<ReportJob>('report', id)
    
    if (cached) {
      return cached
    }
    
    const job = await this.reportRepository.findById(id)
    if (job) {
      // Cache with shorter TTL for active jobs
      const ttl = job.status === ReportJobStatus.COMPLETED || job.status === ReportJobStatus.FAILED 
        ? 300 // 5 minutes for terminal states
        : REPORT_CACHE_TTL
      await cache.set('report', id, job, ttl)
    }
    
    return job
  }

  /**
   * Internal method to process the report.
   */
  private async processReport(id: string): Promise<void> {
    try {
      // 1. Mark as running
      await this.updateStatusWithInvalidation(id, ReportJobStatus.RUNNING)

      // 2. Simulate report generation work
      await new Promise((resolve) => setTimeout(resolve, 5000))

      // 3. Complete job with artifact URL
      await this.updateStatusWithInvalidation(id, ReportJobStatus.COMPLETED, {
        artifactUrl: `https://artifacts.credence.example.com/reports/${id}.pdf`,
      })
    } catch (error) {
      // Handle failure
      const failureReason = error instanceof Error ? error.message : 'Unknown error'
      await this.updateStatusWithInvalidation(id, ReportJobStatus.FAILED, {
        failureReason: 'INTERNAL_ERROR', // Avoid exposing internal stack traces as per requirements
      })
    }
  }

  /**
   * Update report status with cache invalidation.
   */
  private async updateStatusWithInvalidation(
    id: string,
    status: ReportJobStatus,
    metadata?: any
  ): Promise<void> {
    await this.reportRepository.updateStatus(id, status, metadata)
    
    // Invalidate cache after status update
    const job = await this.reportRepository.findById(id)
    if (job) {
      await invalidateCache('report', id, job, {
        verify: true,
        verifyFn: (cached, fresh) => cached.status !== fresh.status
      })
    }
  }
}
