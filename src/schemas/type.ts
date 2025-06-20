import {
    CreateTransactionSchema,
    UpdateTransactionStatusSchema,
} from './app.schema';
import { z } from 'zod';

export type CreateTransactionDto = z.infer<typeof CreateTransactionSchema>;
export type UpdateTransactionStatusDto = z.infer<typeof UpdateTransactionStatusSchema>;
