import { z } from 'zod'

/**
 * Schema for creating a payout (settlement).
 */
export const createPayoutSchema = z.object({
  bondId: z.union([z.string(), z.number()]),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid numeric string'),
  transactionHash: z.string().min(1).max(128),
  settledAt: z.string().datetime().optional(),
  status: z.enum(['pending', 'settled', 'failed']).optional(),
})

export type CreatePayoutInput = z.infer<typeof createPayoutSchema>
