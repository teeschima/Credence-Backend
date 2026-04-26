import { Router, Request, Response } from 'express'
import { SettlementsRepository } from '../db/repositories/settlementsRepository.js'
import { parsePaginationParams, encodeCursor } from '../lib/pagination.js'
import { pool } from '../db/pool.js'

/**
 * Creates the transactions router for history and reporting.
 */
export function createTransactionsRouter(): Router {
  const router = Router()
  const settlementsRepo = new SettlementsRepository(pool)

  /**
   * GET /api/transactions/history
   * 
   * Fetches transaction history (settlements) with stable cursor-based pagination.
   */
  router.get('/history', async (req: Request, res: Response, next) => {
    try {
      const { limit, decodedCursor } = parsePaginationParams(req.query as Record<string, unknown>)
      const bondId = req.query.bondId as string | undefined

      const settlements = await settlementsRepo.findManyPaginated({
        limit,
        cursor: decodedCursor,
        bondId,
      })

      let nextCursor: string | null = null
      if (settlements.length > 0) {
        const last = settlements[settlements.length - 1]
        nextCursor = encodeCursor(last.settledAt.toISOString(), last.id)
      }

      res.status(200).json({
        success: true,
        data: settlements,
        next_cursor: nextCursor,
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}

export default createTransactionsRouter
