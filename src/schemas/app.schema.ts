import { z } from 'zod';
import { PaymentMethod, PaymentStatus } from '../generated/prisma';

export const CreateTransactionSchema = z.object({
    bookingId: z.number(),
    amount: z.number().positive(),
    method: z.nativeEnum(PaymentMethod),
    userId: z.number()
});

export const UpdateTransactionStatusSchema = z.object({
    transactionId: z.number(),
    status: z.nativeEnum(PaymentStatus),
    paidAt: z.date().optional(),
});
