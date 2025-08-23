import {
  PrismaClient,
  PaymentMethod,
  PaymentStatus,
  PaymentTransactionStatus,
  Transaction,
  ProposalStatus,
  Wallet,
  PaymentTransaction,
  BookingStatus,
} from "../generated/prisma";
import { AppError } from "../handlers/error";

const prisma = new PrismaClient();

/**
 * Internal helper: upsert Transaction theo bookingId (unique).
 * - Nếu đã PAID → chặn.
 * - Nếu PENDING/FAILED → xóa cũ, tạo mới (đảm bảo chỉ 1 transaction/booking).
 */
export const upsertBookingTransaction = async ({
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
          409,
        );
      }

      if (
        existing.status === PaymentStatus.PENDING ||
        existing.status === PaymentStatus.FAILED
      ) {
        // Update thay vì delete để giữ audit
        return tx.transaction.update({
          where: { id: existing.id },
          data: {
            amount,
            method,
            orderCode,
            status: PaymentStatus.PENDING,
            createdById: createdById ?? null,
          },
        });
      }
    }

    // Nếu chưa có transaction nào → tạo mới
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
  return upsertBookingTransaction({
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
export const topUpWallet = async (
  userId: number,
  amount: number,
): Promise<void> => {
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
      500,
    );
  }
};

/**
 * Tìm ví theo userId
 */
export const findWalletByUserId = async (
  userId: number,
): Promise<Wallet | null> => {
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
type CreatePaymentTxBase = {
  referenceNumber: string; // orderCode từ cổng
  gateway: string; // "PAYOS" | "MOMO" | ...
  status?: PaymentTransactionStatus; // mặc định PENDING
  accountNumber?: string | null;
  subAccount?: string | null;
  body?: string | null; // JSON string tuỳ ý (metadata)
  serviceRequestId?: number | null; // gắn nếu giao dịch liên quan SR (tuỳ nghiệp vụ)
};

type CreateTopUp = CreatePaymentTxBase & {
  kind: "TOPUP";
  userId: number; // chủ ví
  amount: number; // số tiền nạp
};

type CreateDeposit = CreatePaymentTxBase & {
  kind: "DEPOSIT";
  userId: number;
  serviceRequestId: number;
  amount: number;
  description?: string;
};

type CreatePaymentTx = CreateTopUp | CreateDeposit;

/**
 * Tạo PaymentTransaction dùng được cho cả:
 * - TOPUP (amountIn = amount, amountOut = 0)
 * - DEPOSIT (amountOut = amount, amountIn = 0)
 * Idempotent nhẹ theo referenceNumber: nếu đã có PENDING/PROCESSING -> trả về luôn.
 */
export const createPaymentTransaction = async (
  input: CreatePaymentTx,
): Promise<PaymentTransaction> => {
  // 1) Chuẩn hoá & validate số tiền (Int VND)
  const rawAmount = Math.trunc(Number(input.amount));
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    throw new AppError(
      "Error.InvalidAmount",
      { message: "Amount must be a positive integer (VND)" },
      400,
    );
  }

  // 2) Idempotent nhẹ theo referenceNumber + trạng thái đang mở
  const existing = await prisma.paymentTransaction.findFirst({
    where: {
      referenceNumber: input.referenceNumber,
      status: {
        in: [
          PaymentTransactionStatus.PENDING,
          PaymentTransactionStatus.PROCESSING,
        ],
      },
    },
  });
  if (existing) return existing;

  // 3) Common fields
  const commonData = {
    gateway: input.gateway,
    accountNumber: input.accountNumber ?? null,
    subAccount: input.subAccount ?? null,
    accumulated: 0,
    referenceNumber: input.referenceNumber,
    body: input.body ?? null,
    status: input.status ?? PaymentTransactionStatus.PENDING,
  } as const;

  if (input.kind === "TOPUP") {
    // TOPUP: không gắn serviceRequestId
    return prisma.paymentTransaction.create({
      data: {
        ...commonData,
        amountIn: rawAmount,
        amountOut: 0,
        transactionContent: `Top-up for user #${input.userId}`,
        userId: input.userId,
        serviceRequestId: null,
      },
    });
  }

  // ---- DEPOSIT ----
  // Bắt buộc phải có serviceRequestId
  if (!input.serviceRequestId) {
    throw new AppError(
      "Error.ServiceRequestRequired",
      { message: "DEPOSIT requires a valid serviceRequestId." },
      400,
    );
  }

  const txContent =
    input.description?.trim() ||
    `Booking deposit for service request #${input.serviceRequestId}`;

  return prisma.paymentTransaction.create({
    data: {
      ...commonData,
      amountIn: 0,
      amountOut: rawAmount,
      transactionContent: txContent,
      userId: input.userId ?? null,
      serviceRequestId: input.serviceRequestId,
    },
  });
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
      404,
    );
  }

  if (
    paymentTx.status !== PaymentTransactionStatus.PENDING &&
    paymentTx.status !== PaymentTransactionStatus.PROCESSING
  ) {
    throw new AppError(
      "Error.InvalidStatusForSuccess",
      {
        message: `Cannot mark transaction as SUCCESS from status ${paymentTx.status}.`,
      },
      400,
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
      404,
    );
  }

  if (
    paymentTx.status !== PaymentTransactionStatus.PENDING &&
    paymentTx.status !== PaymentTransactionStatus.PROCESSING
  ) {
    throw new AppError(
      "Error.InvalidStatusForFailure",
      {
        message: `Cannot mark transaction as FAILED from status ${paymentTx.status}.`,
      },
      400,
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
      404,
    );
  }

  return upsertBookingTransaction({
    bookingId,
    amount,
    method,
    orderCode,
    createdById,
  });
};

/**
 * Thanh toán proposal bằng ví (INTERNAL WALLET) – dùng PaymentTransaction
 * - Trừ ví
 * - Tạo PaymentTransaction (SUCCESS) gắn với serviceRequestId
 * - Cập nhật Proposal → ACCEPTED
 */
export const payProposalWithWalletAtomic = async (
  userId: number,
  bookingId: number,
  amount: number,
): Promise<Transaction> => {
  const amountVnd = Math.trunc(Number(amount));
  if (!Number.isFinite(amountVnd) || amountVnd <= 0) {
    throw new AppError(
      "Error.InvalidAmount",
      { message: "Amount must be a positive integer (VND)" },
      400,
    );
  }

  return prisma.$transaction(async (tx) => {
    // 1) Validate booking
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true },
    });
    if (!booking) {
      throw new AppError(
        "Error.BookingNotFound",
        { message: `Booking ${bookingId} not found` },
        404,
      );
    }

    // 2) Check wallet
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new AppError(
        "Error.WalletNotFound",
        { message: "Wallet not found for user" },
        404,
      );
    }
    if (wallet.balance < amountVnd) {
      throw new AppError(
        "Error.InsufficientBalance",
        {
          message: "Số dư ví không đủ để thanh toán proposal",
          currentBalance: wallet.balance,
          requiredAmount: amountVnd,
        },
        400,
      );
    }

    // 3) Deduct wallet
    await tx.wallet.update({
      where: { userId },
      data: { balance: { decrement: amountVnd }, updatedAt: new Date() },
    });

    // 4) Create or update Transaction
    const orderCode = `WALLET-${bookingId}-${Date.now()}`;
    const existingTx = await tx.transaction.findUnique({ where: { bookingId } });

    let transaction: Transaction;
    if (existingTx) {
      if (existingTx.status === PaymentStatus.PAID) {
        throw new AppError(
          "Error.TransactionAlreadyPaid",
          { message: `Booking ${bookingId} has already been paid.` },
          409,
        );
      }
      transaction = await tx.transaction.update({
        where: { id: existingTx.id },
        data: {
          amount: amountVnd,
          method: PaymentMethod.WALLET,
          orderCode,
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          createdById: userId,
        },
      });
    } else {
      transaction = await tx.transaction.create({
        data: {
          bookingId,
          amount: amountVnd,
          method: PaymentMethod.WALLET,
          orderCode,
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          createdById: userId,
        },
      });
    }

    // 5) Update Proposal → ACCEPTED
    await tx.proposal.update({
      where: { bookingId },
      data: { status: ProposalStatus.ACCEPTED },
    });

    // 6) Update Booking → CONFIRMED
    await tx.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CONFIRMED },
    });

    return transaction;
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
      Booking: {
        select: { id: true, CustomerProfile: { select: { userId: true } } },
      },
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
): "PENDING" | "PAID" | "FAILED" {
  switch (s) {
    case "PAID":
      return "PAID";
    case "FAILED":
      return "FAILED";
    case "PENDING":
    default:
      return "PENDING";
  }
}

export function mapPaymentTxStatus(
  s: PaymentTransactionStatus,
): "PENDING" | "PAID" | "FAILED" {
  switch (s) {
    case "SUCCESS":
      return "PAID";
    case "FAILED":
    case "CANCELLED":
    case "REFUNDED":
    case "EXPIRED":
      return "FAILED";
    case "PENDING":
    case "PROCESSING":
    case "MANUAL_REVIEW":
    default:
      return "PENDING";
  }
}
