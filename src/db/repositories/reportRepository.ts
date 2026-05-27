import { Pool, PoolClient } from 'pg'
import { ReportJob, ReportJobStatus } from '../../jobs/types.js'

export class ReportRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  /** Maps a raw postgres row (snake_case) to the ReportJob domain type. */
  private map(row: any): ReportJob {
    return {
      id: row.id,
      type: row.type,
      status: row.status as ReportJobStatus,
      failureReason: row.failure_reason || undefined,
      artifactUrl: row.artifact_url || undefined,
      storageKey: row.storage_key || undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }
  }

  /**
   * Creates a new report job entry.
   */
  async create(type: string): Promise<ReportJob> {
    const { rows } = await this.db.query(
      `INSERT INTO report_jobs (type, status)
       VALUES ($1, $2)
       RETURNING id, type, status, failure_reason, artifact_url, storage_key, created_at, updated_at`,
      [type, ReportJobStatus.QUEUED]
    )
    return this.map(rows[0])
  }

  /**
   * Finds a report job by ID.
   */
  async findById(id: string): Promise<ReportJob | null> {
    const { rows } = await this.db.query(
      `SELECT id, type, status, failure_reason, artifact_url, storage_key, created_at, updated_at
       FROM report_jobs
       WHERE id = $1`,
      [id]
    )
    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * Updates the status of a report job.
   */
  async updateStatus(
    id: string,
    status: ReportJobStatus,
    options?: { failureReason?: string; artifactUrl?: string; storageKey?: string }
  ): Promise<ReportJob | null> {
    const { rows } = await this.db.query(
      `UPDATE report_jobs
       SET status = $2,
           failure_reason = COALESCE($3, failure_reason),
           artifact_url = COALESCE($4, artifact_url),
           storage_key = COALESCE($5, storage_key),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, type, status, failure_reason, artifact_url, storage_key, created_at, updated_at`,
      [id, status, options?.failureReason || null, options?.artifactUrl || null, options?.storageKey || null]
    )
    return rows.length ? this.map(rows[0]) : null
  }
}
