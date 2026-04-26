import { Router, Request, Response } from 'express'
import { idempotencyMiddleware } from '../middleware/idempotency.js'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import { SettlementService } from '../services/settlementService.js'
import { validate } from '../middleware/validate.js'
import { createPayoutSchema } from '../schemas/index.js'
import { pool } from '../db/pool.js'
import { SettlementsRepository } from '../db/repositories/settlementsRepository.js'

/**
 * Creates the payouts router with idempotency protection.
 */
export function createPayoutsRouter(): Router {
  const router = Router()
  
  const idempotencyRepo = new IdempotencyRepository(pool)
  const settlementsRepo = new SettlementsRepository(pool)
  const settlementService = new SettlementService(settlementsRepo)

  /**
   * POST /api/payouts
   * 
   * Creates a new payout record.
   * Protected by idempotency keys to prevent duplicate payouts on retries.
   */
  router.post(
    '/',
    idempotencyMiddleware(idempotencyRepo),
    validate({ body: createPayoutSchema }),
    async (req: Request, res: Response, next) => {
      try {
        const body = req.validated!.body as any
        
        const result = await settlementService.upsertSettlementStatus({
          bondId: body.bondId,
          amount: body.amount,
          transactionHash: body.transactionHash,
          settledAt: body.settledAt ? new Date(body.settledAt) : undefined,
          status: body.status,
        })

        res.status(201).json({
          success: true,
          data: result,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}

export default createPayoutsRouter
