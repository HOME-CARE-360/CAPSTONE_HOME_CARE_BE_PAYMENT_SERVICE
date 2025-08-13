import {
  PrismaClient,
  PaymentMethod,
  PaymentStatus,
  PaymentTransactionStatus,
  Transaction,
  ProposalStatus,
  Wallet,
} from "../generated/prisma";
import { AppError } from "../handlers/error";

const prisma = new PrismaClient();

/**
 * Internal helper: upsert Transaction theo bookingId (unique).
 * - Nếu đã PAID → chặn.
 * - Nếu PENDING/FAILED → xóa cũ, tạo mới (đảm bảo chỉ 1 transaction/booking).
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
    const existing = await tx.transaction.findUnique({ where: { bookingId } });

    if (existing) {
      if (existing.status === PaymentStatus.PAID) {
        throw new AppError(
          "Error.TransactionAlreadyPaid",
          { message: `Booking ${bookingId} has already been paid.` },
          409
        );
      }

      if (
        existing.status === PaymentStatus.PENDING ||
        existing.status === PaymentStatus.FAILED
      ) {
        // Có thể cân nhắc update thay vì delete để giữ audit. Ở đây giữ nguyên logic của bạn.
        await tx.transaction.delete({ where: { bookingId } });
      }
    }

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
 * Tạo transaction cho booking (bảng Transaction)
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
  return _upsertBookingTransaction({
    bookingId,
    amount,
    method,
    orderCode,
    createdById,
  });
};

/**
 * Tăng số dư ví (top-up)
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
    throw new AppError(
      "Error.WalletTopUpFailed",
      { message: "Failed to top up wallet", error: err?.message || err },
      500
    );
  }
};

/**
 * Tìm ví theo userId
 */
export const findWalletByUserId = async (userId: number): Promise<Wallet | null> => {
  return prisma.wallet.findUnique({ where: { userId } });
};

/**
 * Tìm Transaction theo orderCode
 */
export const findTransactionByOrderCode = async (orderCode: string) => {
  return prisma.transaction.findUnique({ where: { orderCode } });
};

/**
 * Đánh dấu Transaction (booking) là PAID
 */
export const markTransactionAsPaid = async (orderCode: string) => {
  return prisma.transaction.update({
    where: { orderCode },
    data: { status: PaymentStatus.PAID, paidAt: new Date() },
  });
};

/**
 * Đánh dấu Transaction (booking) là FAILED
 */
export const markTransactionAsFailed = async (orderCode: string) => {
  return prisma.transaction.update({
    where: { orderCode },
    data: { status: PaymentStatus.FAILED },
  });
};

/**
 * Tạo PaymentTransaction cho top-up (bảng PaymentTransaction)
 * ❶ Theo schema: dùng referenceNumber để lưu orderCode từ PayOS
 * ❷ amountIn là số tiền nạp vào ví (Int)
 */
export const createPaymentTransaction = async ({
  userId,
  referenceNumber,   // FIX: đồng bộ với service & schema
  amountIn,          // FIX: đồng bộ với service & schema
  amountOut = 0,
  gateway,
  status,
}: {
  userId: number;
  referenceNumber: string; // PayOS orderCode (string)
  amountIn: number;        // số tiền vào ví
  amountOut?: number;      // mặc định 0 cho top-up
  gateway: string;         // "PAYOS"
  status: PaymentTransactionStatus;
}) => {
  try {
    return await prisma.paymentTransaction.create({
      data: {
        gateway,
        accountNumber: null,
        subAccount: null,
        amountIn,              // FIX
        amountOut,             // FIX
        accumulated: 0,
        referenceNumber,       // FIX
        transactionContent: `Top-up for user #${userId}`,
        body: null,
        serviceRequestId: null,
        status,
        userId,
      },
    });
  } catch (err: any) {
    console.error("❌ Error creating paymentTransaction:", err);
    throw new AppError(
      "Error.PaymentTransactionCreateFailed",
      { message: "Failed to create payment transaction", error: err?.message || err },
      500
    );
  }
};

/**
 * Tìm PaymentTransaction theo referenceNumber (orderCode PayOS)
 */
export const findPaymentTransactionByReference = async (orderCode: string) => {
  return prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });
};

/**
 * Đánh dấu top-up PaymentTransaction là SUCCESS
 * - Chỉ khi đang PENDING/PROCESSING
 * - (Tuỳ nghiệp vụ) accumulated = amountIn
 */
export const markPaymentTransactionAsPaid = async (orderCode: string) => {
  const paymentTx = await prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });

  if (!paymentTx) {
    throw new AppError(
      "Error.PaymentTransactionNotFound",
      { message: `Top-up transaction with orderCode ${orderCode} not found.` },
      404
    );
  }

  if (
    paymentTx.status !== PaymentTransactionStatus.PENDING &&
    paymentTx.status !== PaymentTransactionStatus.PROCESSING
  ) {
    throw new AppError(
      "Error.InvalidStatusForSuccess",
      { message: `Cannot mark transaction as SUCCESS from status ${paymentTx.status}.` },
      400
    );
  }

  return prisma.paymentTransaction.update({
    where: { id: paymentTx.id },
    data: {
      status: PaymentTransactionStatus.SUCCESS,
      accumulated: paymentTx.amountIn, // có thể bỏ nếu không cần
    },
  });
};

/**
 * Đánh dấu top-up PaymentTransaction là FAILED
 * - Chỉ khi đang PENDING/PROCESSING
 */
export const markPaymentTransactionAsFailed = async (orderCode: string) => {
  const paymentTx = await prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
  });

  if (!paymentTx) {
    throw new AppError(
      "Error.PaymentTransactionNotFound",
      { message: `Top-up transaction with orderCode ${orderCode} not found.` },
      404
    );
  }

  if (
    paymentTx.status !== PaymentTransactionStatus.PENDING &&
    paymentTx.status !== PaymentTransactionStatus.PROCESSING
  ) {
    throw new AppError(
      "Error.InvalidStatusForFailure",
      { message: `Cannot mark transaction as FAILED from status ${paymentTx.status}.` },
      400
    );
  }

  return prisma.paymentTransaction.update({
    where: { id: paymentTx.id },
    data: { status: PaymentTransactionStatus.FAILED },
  });
};

/**
 * Tạo/đổi Transaction khi thanh toán Proposal theo bookingId
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
    throw new AppError(
      "Error.ProposalNotFound",
      { message: `No proposal found for bookingId ${bookingId}` },
      404
    );
  }

  return _upsertBookingTransaction({
    bookingId,
    amount,
    method,
    orderCode,
    createdById,
  });
};

/**
 * Thanh toán proposal bằng ví: atomic
 * - Kiểm tra và trừ ví (không để âm)
 * - Tạo Transaction & đánh dấu PAID
 * - Cập nhật Proposal → ACCEPTED
 */
export const payProposalWithWalletAtomic = async (
  userId: number,
  bookingId: number,
  amount: number
): Promise<Transaction> => {
  return prisma.$transaction(async (tx) => {
    // Đọc ví và kiểm tra số dư ngay trong transaction để an toàn
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new AppError("Error.WalletNotFound", { message: "Wallet not found for user" }, 404);
    }
    if (wallet.balance < amount) {
      throw new AppError(
        "Error.InsufficientBalance",
        { message: "Số dư ví không đủ để thanh toán proposal", currentBalance: wallet.balance, requiredAmount: amount },
        400
      );
    }

    // Trừ ví
    await tx.wallet.update({
      where: { userId },
      data: { balance: { decrement: amount }, updatedAt: new Date() },
    });

    // Tạo Transaction → PAID ngay (vì ví nội bộ)
    const newTransaction = await tx.transaction.create({
      data: {
        bookingId,
        amount,
        // Schema PaymentMethod hiện không có WALLET → tạm dùng CASH như đã thảo luận
        method: PaymentMethod.CASH, // FIX: tạm map ví = CASH (nên thêm WALLET vào enum nếu muốn rõ ràng)
        orderCode: `WALLET-${bookingId}-${Date.now()}`,
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        createdById: userId,
      },
    });

    await tx.proposal.update({
      where: { bookingId },
      data: { status: ProposalStatus.ACCEPTED },
    });

    return newTransaction;
  });
};

export const findProposalByBookingId = async (bookingId: number) => {
  return prisma.proposal.findUnique({ where: { bookingId } });
};

export const findProposalByBookingIdWithItems = async (bookingId: number) => {
  return prisma.proposal.findUnique({
    where: { bookingId },
    include: {
      ProposalItem: {
        include: {
          Service: { select: { virtualPrice: true } },
        },
      },
    },
  });
};
export async function getBookingTxWithOwner(orderCode: string) {
  return prisma.transaction.findUnique({
    where: { orderCode },
    include: {
      Booking: { select: { id: true, CustomerProfile: { select: { userId: true } } } },
    },
  });
}

export async function getPaymentTxByReference(orderCode: string) {
  return prisma.paymentTransaction.findFirst({
    where: { referenceNumber: orderCode },
    select: {
      id: true,
      userId: true,
      amountIn: true,
      status: true,
      transactionDate: true,
      serviceRequestId: true,
    },
  });
}

/** Map PaymentStatus -> unified status */
export function mapBookingTxStatus(
  s: PaymentStatus,
): 'PENDING' | 'PAID' | 'FAILED' {
  switch (s) {
    case 'PAID':
      return 'PAID';
    case 'FAILED':
      return 'FAILED';
    case 'PENDING':
    default:
      return 'PENDING';
  }
}

export function mapPaymentTxStatus(
  s: PaymentTransactionStatus,
): 'PENDING' | 'PAID' | 'FAILED' {
  switch (s) {
    case 'SUCCESS':
      return 'PAID';
    case 'FAILED':
    case 'CANCELLED':
    case 'REFUNDED':
    case 'EXPIRED':
      return 'FAILED';
    case 'PENDING':
    case 'PROCESSING':
    case 'MANUAL_REVIEW':
    default:
      return 'PENDING';
  }
}