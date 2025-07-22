import {
    CreateTransactionSchema,
    UpdateTransactionStatusSchema,
    WalletTopUpSchema,
} from './app.schema';
import { z } from 'zod';

export type CreateTransactionDto = z.infer<typeof CreateTransactionSchema>;
export type UpdateTransactionStatusDto = z.infer<typeof UpdateTransactionStatusSchema>;
export type WalletTopUpDto = z.infer<typeof WalletTopUpSchema>;
