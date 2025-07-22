import { PrismaClient, PaymentMethod, PaymentStatus, PaymentTransactionStatus, Transaction } from "../generated/prisma";

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
  createdById?: number;
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

/**
 * Nạp tiền vào ví (Wallet)
 */
export async function topUpWallet(userId: number, amount: number): Promise<void> {
  await prisma.wallet.update({
    where: { userId },
    data: {
      balance: {
        increment: amount,
      },
      updatedAt: new Date(),
    },
  });
}

export const findTransactionByOrderCode = async (orderCode: string) => {
  return prisma.transaction.findUnique({ where: { orderCode } });
};

export const markTransactionAsPaid = async (orderCode: string) => {
  return prisma.transaction.update({
    where: { orderCode },
    data: {
      status: PaymentStatus.PAID,
      paidAt: new Date(),
    },
  });
};

export const markTransactionAsFailed = async (orderCode: string) => {
  return prisma.transaction.update({
    where: { orderCode },
    data: {
      status: PaymentStatus.FAILED,
    },
  });
};

/**
 * Tạo PaymentTransaction cho top-up
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
  return prisma.paymentTransaction.create({
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
      createdAt: new Date(),
    },
  });
};

export const findPaymentTransactionByReference = async (orderCode: string) => {
  return prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });
};

export const markPaymentTransactionAsPaid = async (orderCode: string) => {
  const paymentTx = await prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });

  if (!paymentTx) {
    throw new Error("PaymentTransaction not found");
  }

  return prisma.paymentTransaction.updateMany({
    where: { referenceNumber: orderCode },
    data: {
      status: PaymentTransactionStatus.SUCCESS,
      accumulated: paymentTx.amountIn,
    },
  });
};

export const markPaymentTransactionAsFailed = async (orderCode: string) => {
  return prisma.paymentTransaction.updateMany({
    where: { referenceNumber: orderCode },
    data: {
      status: PaymentTransactionStatus.FAILED,
    },
  });
};
