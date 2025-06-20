import { PrismaClient, PaymentMethod, PaymentStatus, Transaction } from "../generated/prisma";

const prisma = new PrismaClient();

/**
 * Create a new transaction record in the database
 */
export const createTransaction = async ({
    bookingId,
    amount,
    method,
    orderCode,
    createdById,
}: {
    bookingId: number;
    amount: number;
    method: PaymentMethod;
    orderCode: string;
    createdById?: number; // optional
}): Promise<Transaction> => {
    return prisma.transaction.create({
        data: {
            bookingId,
            amount,
            method,
            orderCode,
            status: PaymentStatus.PENDING,
            createdById: createdById ?? null,
        },
    });
};
