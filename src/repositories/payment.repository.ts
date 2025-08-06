import {
  PrismaClient,
  PaymentMethod,
  PaymentStatus,
  PaymentTransactionStatus,
  Transaction,
} from "../generated/prisma";
import { AppError } from "../handlers/error";

const prisma = new PrismaClient();

/**
 * Create a new transaction record in the database.
 * If bookingId is unique, ensure only one transaction exists per booking.
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
  createdById?: number;
}): Promise<Transaction> => {
  const existing = await prisma.transaction.findUnique({
    where: { bookingId },
  });

  if (existing) {
    if (existing.status === PaymentStatus.PAID) {
      throw new AppError("Error.TransactionAlreadyPaid", {
        message: `Booking ${bookingId} has already been paid.`,
      }, 409);
    }

    if (existing.status === PaymentStatus.PENDING || existing.status === PaymentStatus.FAILED) {
      // ✅ Option: reuse existing transaction OR delete and create new one
      await prisma.transaction.delete({ where: { bookingId } });
    }
  }

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

/**
 * Increase wallet balance
 */
export const topUpWallet = async (userId: number, amount: number): Promise<void> => {
  try {
    await prisma.wallet.update({
      where: { userId },
      data: {
        balance: { increment: amount },
        updatedAt: new Date(),
      },
    });
  } catch (err: any) {
    console.error("❌ Error updating wallet:", err);
    throw new AppError("Error.WalletTopUpFailed", {
      message: "Failed to top up wallet",
      error: err?.message || err,
    }, 500);
  }
};

/**
 * Find transaction by orderCode
 */
export const findTransactionByOrderCode = async (orderCode: string) => {
  return prisma.transaction.findUnique({ where: { orderCode } });
};

/**
 * Mark a transaction as paid
 */
export const markTransactionAsPaid = async (orderCode: string) => {
  return prisma.transaction.update({
    where: { orderCode },
    data: {
      status: PaymentStatus.PAID,
      paidAt: new Date(),
    },
  });
};

/**
 * Mark a transaction as failed
 */
export const markTransactionAsFailed = async (orderCode: string) => {
  return prisma.transaction.update({
    where: { orderCode },
    data: {
      status: PaymentStatus.FAILED,
    },
  });
};

/**
 * Create a PaymentTransaction for top-up
 */
export const createPaymentTransaction = async ({
  userId,
  amount,
  orderCode,
  gateway,
  status,
}: {
  userId: number;
  amount: number;
  orderCode: string;
  gateway: string;
  status: PaymentTransactionStatus;
}) => {
  try {
    return await prisma.paymentTransaction.create({
      data: {
        gateway,
        accountNumber: null,
        subAccount: null,
        amountIn: amount,
        amountOut: 0,
        accumulated: 0,
        referenceNumber: orderCode,
        transactionContent: `Top-up for user #${userId}`,
        body: null,
        serviceRequestId: null,
        status,
        userId,
      },
    });
  } catch (err: any) {
    console.error("❌ Error creating paymentTransaction:", err);
    throw new AppError("Error.PaymentTransactionCreateFailed", {
      message: "Failed to create payment transaction",
      error: err?.message || err,
    }, 500);
  }
};

/**
 * Find payment transaction by reference number
 */
export const findPaymentTransactionByReference = async (orderCode: string) => {
  return prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });
};

/**
 * Mark top-up transaction as paid
 * BUSINESS RULES:
 * - BR1: Only update if current status is PENDING or PROCESSING
 * - BR2: Cannot mark as SUCCESS if already marked as SUCCESS, FAILED, or CANCELLED
 * - BR3: Accumulated balance must match amountIn
 */
export const markPaymentTransactionAsPaid = async (orderCode: string) => {
  const paymentTx = await prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });

  if (!paymentTx) {
    throw new AppError("Error.PaymentTransactionNotFound", {
      message: `Top-up transaction with orderCode ${orderCode} not found.`,
    }, 404);
  }

  if (
    paymentTx.status !== PaymentTransactionStatus.PENDING &&
    paymentTx.status !== PaymentTransactionStatus.PROCESSING
  ) {
    throw new AppError("Error.InvalidStatusForSuccess", {
      message: `Cannot mark transaction as SUCCESS from status ${paymentTx.status}.`,
    }, 400);
  }

  return prisma.paymentTransaction.update({
    where: { id: paymentTx.id },
    data: {
      status: PaymentTransactionStatus.SUCCESS,
      accumulated: paymentTx.amountIn,
    },
  });
};

/**
 * Mark top-up transaction as failed
 * BUSINESS RULES:
 * - BR1: Only update if current status is PENDING or PROCESSING
 * - BR2: Cannot mark as FAILED if already marked as SUCCESS or CANCELLED
 */
export const markPaymentTransactionAsFailed = async (orderCode: string) => {
  const paymentTx = await prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });

  if (!paymentTx) {
    throw new AppError("Error.PaymentTransactionNotFound", {
      message: `Top-up transaction with orderCode ${orderCode} not found.`,
    }, 404);
  }

  if (
    paymentTx.status !== PaymentTransactionStatus.PENDING &&
    paymentTx.status !== PaymentTransactionStatus.PROCESSING
  ) {
    throw new AppError("Error.InvalidStatusForFailure", {
      message: `Cannot mark transaction as FAILED from status ${paymentTx.status}.`,
    }, 400);
  }

  return prisma.paymentTransaction.update({
    where: { id: paymentTx.id },
    data: {
      status: PaymentTransactionStatus.FAILED,
    },
  });
};
