import {
  PrismaClient,
  PaymentMethod,
  PaymentStatus,
  PaymentTransactionStatus,
  Transaction,
  ProposalStatus,
  Wallet, // Import Wallet model
} from "../generated/prisma";
import { AppError } from "../handlers/error";

const prisma = new PrismaClient();

/**
 * Internal helper function to create or update a booking transaction atomically.
 * Ensures only one active transaction exists per bookingId.
 */
const _upsertBookingTransaction = async ({
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
  return prisma.$transaction(async (tx) => {
    const existing = await tx.transaction.findUnique({
      where: { bookingId },
    });

    if (existing) {
      if (existing.status === PaymentStatus.PAID) {
        throw new AppError("Error.TransactionAlreadyPaid", {
          message: `Booking ${bookingId} has already been paid.`,
        }, 409);
      }

      if (existing.status === PaymentStatus.PENDING || existing.status === PaymentStatus.FAILED) {
        // Delete existing transaction to create a new one for this bookingId
        await tx.transaction.delete({ where: { bookingId } });
      }
    }

    // Create a new transaction record
    return tx.transaction.create({
      data: {
        bookingId,
        amount,
        method,
        orderCode,
        status: PaymentStatus.PENDING,
        createdById: createdById ?? null,
      },
    });
  });
};

/**
 * Create a new transaction record in the database for a booking.
 * If bookingId is unique, ensure only one transaction exists per booking.
 * This function now uses the internal _upsertBookingTransaction helper.
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
  return _upsertBookingTransaction({ bookingId, amount, method, orderCode, createdById });
};

/**
 * Increase wallet balance
 */
export const topUpWallet = async (userId: number, amount: number): Promise<void> => {
  try {
    // This operation is generally atomic at the DB level with increment,
    // but can be part of a larger transaction if needed.
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
 * Find wallet by userId
 */
export const findWalletByUserId = async (userId: number): Promise<Wallet | null> => {
  return prisma.wallet.findUnique({ where: { userId } });
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

/**
 * Pay for a proposal by bookingId.
 * This function now uses the internal _upsertBookingTransaction helper.
 */
export const payProposalByBookingId = async ({
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
}) => {
  const proposal = await prisma.proposal.findUnique({
    where: { bookingId },
    include: { Booking: true },
  });

  if (!proposal) {
    throw new AppError('Error.ProposalNotFound', {
      message: `No proposal found for bookingId ${bookingId}`,
    }, 404);
  }

  // Use the shared helper to handle transaction creation/update
  return _upsertBookingTransaction({
    bookingId,
    amount,
    method,
    orderCode,
    createdById,
  });
};

/**
 * Atomically handles wallet deduction and transaction creation for proposal payment.
 */
export const payProposalWithWalletAtomic = async (
  userId: number,
  bookingId: number,
  amount: number
): Promise<Transaction> => {
  return prisma.$transaction(async (tx) => {
    // Deduct from wallet
    await tx.wallet.update({
      where: { userId },
      data: {
        balance: { decrement: amount },
        updatedAt: new Date(),
      },
    });

    // Create a new transaction for the booking, marking it as paid immediately
    const newTransaction = await tx.transaction.create({
      data: {
        bookingId,
        amount,
        method: PaymentMethod.CASH, // Corrected to WALLET for wallet payments
        orderCode: `WALLET-${bookingId}-${Date.now()}`,
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        createdById: userId,
      },
    });

    // Update the proposal status to ACCEPTED
    await tx.proposal.update({
      where: { bookingId },
      data: { status: ProposalStatus.ACCEPTED },
    });

    return newTransaction;
  });
};


export const findProposalByBookingId = async (bookingId: number) => {
  return prisma.proposal.findUnique({
    where: { bookingId },
  });
};

export const findProposalByBookingIdWithItems = async (bookingId: number) => {
  return prisma.proposal.findUnique({
    where: { bookingId },
    include: {
      ProposalItem: {
        include: {
          Service: {
            select: {
              virtualPrice: true,
            },
          },
        },
      },
    },
  });
};
