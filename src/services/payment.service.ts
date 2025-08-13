import { ZodError } from "zod";
import PayOS from "@payos/node";
import { CreateTransactionDto, WalletTopUpDto } from "../schemas/type";
import { CreateTransactionSchema, WalletTopUpSchema } from "../schemas/app.schema";
import { AppError } from "../handlers/error";
import {
  PaymentMethod,
  PaymentStatus,
  PaymentTransactionStatus,
  ProposalStatus,
  PrismaClient,
} from "../generated/prisma";
import * as paymentRepo from "../repositories/payment.repository";
import { CheckoutResponseDataType } from "@payos/node/lib/type";

// NOTE: Tốt nhất dùng 1 instance Prisma chung, nhưng giữ nguyên phong cách file này:
const prisma = new PrismaClient();

// Khởi tạo PayOS SDK (đúng bộ key của PayOS)
const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID!,     // clientId của PayOS
  process.env.PAYOS_API_KEY!,       // apiKey của PayOS
  process.env.PAYOS_CHECKSUM_KEY!   // checksumKey của PayOS
);

/**
 * Validate Zod – fail thì ném AppError 422
 */
function validateOrThrow<T>(schema: any, data: T): void {
  try {
    schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AppError(
        "Error.Validation",
        err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
        422
      );
    }
    throw new AppError("Error.ValidationUnexpected", { message: "Unexpected validation error" }, 400);
  }
}

/**
 * Gọi PayOS tạo payment link
 */
async function requestPayOS(
  orderCode: number,
  amount: number,
  description: string
): Promise<CheckoutResponseDataType> {
  const clientUrl = "https://api.homecare360.space";
  if (!clientUrl) {
    throw new AppError(
      "Error.MissingEnv",
      { message: "Thiếu biến môi trường CLIENT_BASE_URL (base URL của client/app)" },
      500
    );
  }

  const cancelUrl = `${clientUrl}/payments/status?orderCode=${orderCode}`;
  const returnUrl = `${clientUrl}/payments/status?orderCode=${orderCode}`;

  const payload = { orderCode, amount, description, cancelUrl, returnUrl };
  console.log("📦 Sending to PayOS:", payload);

  try {
    const res = await payos.createPaymentLink(payload);
    if (!res?.checkoutUrl) throw new Error("Không nhận được checkoutUrl từ PayOS");
    return res;
  } catch (err: any) {
    console.error("🚨 PayOS Error:", err?.response?.data ?? err?.message ?? err);
    throw new AppError(
      "Error.PayosAPI",
      { message: "Không thể tạo payment link từ PayOS", error: err?.response?.data ?? err?.message ?? err },
      502
    );
  }
}

/**
 * Tạo giao dịch thanh toán booking (bảng Transaction) + tạo link PayOS
 */
export const createTransaction = async (data: CreateTransactionDto) => {
  validateOrThrow(CreateTransactionSchema, data);

  // orderCode numeric, không quá dài (gộp bookingId + 6 số cuối timestamp)
  const orderCode = Number(`${data.bookingId}${Date.now().toString().slice(-6)}`);
  const description = `Thanh toán đơn hàng #${data.bookingId}`;

  const responseData = await requestPayOS(orderCode, data.amount, description);

  // Lưu Transaction – theo schema Transaction có orderCode (String? @unique)
  const transaction = await paymentRepo.createTransaction({
    bookingId: data.bookingId,
    amount: data.amount,
    method: data.method || PaymentMethod.BANK_TRANSFER,
    orderCode: orderCode.toString(),
    createdById: data.userId,
  });

  return {
    message: "Transaction created",
    transactionId: transaction.id,
    bookingId: transaction.bookingId,
    amount: transaction.amount,
    method: transaction.method,
    status: transaction.status,
    createdAt: transaction.createdAt,
    createdById: transaction.createdById,
    responseData,
  };
};

/**
 * Tạo giao dịch nạp ví (bảng PaymentTransaction) + tạo link PayOS
 */
export const createWalletTopUpUsingPaymentTransaction = async (data: WalletTopUpDto) => {
  validateOrThrow(WalletTopUpSchema, data);

  const orderCode = Date.now(); // unique numeric
  const description = `Nạp tiền vào ví #${data.userId}`;
  const responseData = await requestPayOS(orderCode, data.amount, description);

  // FIX: Schema PaymentTransaction dùng referenceNumber, amountIn (không có orderCode/amount)
  await paymentRepo.createPaymentTransaction({
    userId: data.userId,
    gateway: "PAYOS",                    // gateway là String – OK
    referenceNumber: orderCode.toString(), // lưu mã PayOS vào referenceNumber
    amountIn: data.amount,               // số tiền nạp vào ví
    amountOut: 0,
    status: PaymentTransactionStatus.PENDING,
    // serviceRequestId: null // nếu repo yêu cầu, bổ sung cho đúng chữ ký
  });

  return { responseData };
};

/**
 * Callback PayOS (PAID | FAILED)
 * - Nếu là booking payment → bảng Transaction
 * - Nếu là nạp ví → bảng PaymentTransaction (tra theo referenceNumber)
 */
export const handlePayOSCallback = async (payload: { orderCode: string; status: "PAID" | "FAILED" }) => {
  const { orderCode, status } = payload;

  return prisma.$transaction(async (tx) => {
    // 1) Booking transaction (Transaction.orderCode)
    const transaction = await tx.transaction.findUnique({ where: { orderCode } });

    if (transaction) {
      if (transaction.status !== PaymentStatus.PENDING) {
        return { message: "Booking transaction already handled" };
      }

      if (status === "PAID") {
        await tx.transaction.update({
          where: { orderCode },
          data: { status: PaymentStatus.PAID, paidAt: new Date() },
        });

        if (transaction.bookingId) {
          // tuỳ nghiệp vụ, bạn đang set Proposal → ACCEPTED
          await tx.proposal.update({
            where: { bookingId: transaction.bookingId },
            data: { status: ProposalStatus.ACCEPTED },
          });
        }

        return { message: "Booking payment success handled" };
      }

      if (status === "FAILED") {
        await tx.transaction.update({
          where: { orderCode },
          data: { status: PaymentStatus.FAILED },
        });
        return { message: "Booking payment failure handled" };
      }

      throw new AppError("Error.InvalidStatus", { status }, 400);
    }

    // 2) Wallet top-up (PaymentTransaction.referenceNumber)
    // FIX: tra theo referenceNumber (không phải orderCode)
    const paymentTransaction = await tx.paymentTransaction.findFirst({
      where: { referenceNumber: orderCode },
    });

    if (!paymentTransaction) {
      throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
    }

    if (
      paymentTransaction.status !== PaymentTransactionStatus.PENDING &&
      paymentTransaction.status !== PaymentTransactionStatus.PROCESSING
    ) {
      return { message: "Wallet top-up already handled or in an unchangeable state" };
    }

    if (status === "PAID") {
      await tx.paymentTransaction.update({
        where: { id: paymentTransaction.id },
        data: {
          status: PaymentTransactionStatus.SUCCESS,
          // accumulated: paymentTransaction.amountIn, // nếu bạn dùng accumulated cho báo cáo, có thể set
        },
      });

      if (paymentTransaction.userId) {
        // FIX: cộng ví theo amountIn (Int) → Wallet.balance (Float)
        await tx.wallet.update({
          where: { userId: paymentTransaction.userId },
          data: { balance: { increment: paymentTransaction.amountIn } },
        });
      }

      return { message: "Wallet top-up success handled" };
    }

    if (status === "FAILED") {
      await tx.paymentTransaction.update({
        where: { id: paymentTransaction.id },
        data: { status: PaymentTransactionStatus.FAILED },
      });
      return { message: "Wallet top-up failure handled" };
    }

    throw new AppError("Error.InvalidStatus", { status }, 400);
  });
};

/**
 * Thanh toán proposal bằng ví nội bộ (atomic trong repo)
 */
export const payProposalWithWallet = async ({
  bookingId,
  userId,
}: {
  bookingId: number;
  userId: number;
}) => {
  const proposal = await paymentRepo.findProposalByBookingIdWithItems(bookingId);
  if (!proposal || proposal.status !== ProposalStatus.ACCEPTED) {
    throw new AppError(
      "Error.ProposalNotAccepted",
      { message: `Proposal for booking #${bookingId} is not accepted or doesn't exist.` },
      400
    );
  }

  const total = proposal.ProposalItem.reduce(
    (sum, item) => sum + item.quantity * item.Service.virtualPrice,
    0
  );

  const wallet = await paymentRepo.findWalletByUserId(userId);
  if (!wallet || wallet.balance < total) {
    throw new AppError(
      "Error.InsufficientWalletBalance",
      { message: "Not enough balance to pay for proposal." },
      400
    );
  }

  await paymentRepo.payProposalWithWalletAtomic(userId, bookingId, total);

  return { message: "Proposal paid successfully via wallet." };
};

/**
 * Tạo thanh toán proposal (ví nội bộ tạm map = CASH; gateway khác → PayOS)
 * Lưu ý: enum PaymentMethod hiện chưa có WALLET trong schema của bạn.
 * Nếu muốn rõ ràng, hãy thêm WALLET vào enum và migrate DB.
 */
export const createProposalPayment = async ({
  bookingId,
  method,
  userId,
}: {
  bookingId: number;
  method?: PaymentMethod;
  userId: number;
}) => {
  const proposal = await paymentRepo.findProposalByBookingIdWithItems(bookingId);

  if (!proposal) {
    throw new AppError("Error.ProposalNotFound", { message: `No proposal found for booking #${bookingId}` }, 404);
  }

  if (proposal.status !== ProposalStatus.ACCEPTED) {
    throw new AppError("Error.ProposalNotAccepted", { message: `Proposal for booking #${bookingId} is not accepted` }, 400);
  }

  const amount = proposal.ProposalItem.reduce(
  (sum, item) => sum + item.quantity * item.Service.virtualPrice,
  0
) - 100000;


  if (amount <= 0) {
    throw new AppError("Error.InvalidAmount", { message: "Invalid proposal amount" }, 400);
  }

  const paymentMethod = method || PaymentMethod.BANK_TRANSFER;

  const isWallet = paymentMethod === PaymentMethod.WALLET;

  if (isWallet) {
    const wallet = await paymentRepo.findWalletByUserId(userId);
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

    const transaction = await paymentRepo.payProposalWithWalletAtomic(userId, bookingId, amount);

    return {
      message: "Proposal paid using wallet successfully",
      transactionId: transaction.id,
      bookingId: transaction.bookingId,
      amount: transaction.amount,
      method: transaction.method,
      status: PaymentStatus.PAID,
      createdAt: transaction.createdAt,
    };
  }

  // Pay qua PayOS (BANK_TRANSFER / v.v…)
  const orderCode = Number(`${bookingId}${Date.now().toString().slice(-6)}`);
  const description = `Thanh toán proposal ${bookingId}`;
  const responseData = await requestPayOS(orderCode, amount, description);

  const transaction = await paymentRepo.createTransaction({
    bookingId,
    amount,
    method: paymentMethod,
    orderCode: orderCode.toString(),
    createdById: userId,
  });

  return {
    message: "Proposal payment initiated",
    transactionId: transaction.id,
    bookingId: transaction.bookingId,
    amount: transaction.amount,
    method: transaction.method,
    status: transaction.status,
    createdAt: transaction.createdAt,
    responseData,
  };
}


export async function getPaymentStatus(orderCode: string, userId: number) {
  // Validate input
  if (!orderCode || typeof orderCode !== 'string') {
    throw new AppError(
      'Error.InvalidOrderCode',
      [{ path: ['orderCode'], message: 'orderCode is required (string)' }],
      400
    );
  }
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new AppError(
      'Error.InvalidUserId',
      [{ path: ['userId'], message: 'userId must be a positive number' }],
      400
    );
  }

const bookingTx = await paymentRepo.getBookingTxWithOwner(orderCode);
  if (bookingTx) {
    const booking = bookingTx.Booking;
    if (!booking) {
      throw new AppError(
        'Error.BookingNotFound',
        [{ path: ['booking'], message: 'Booking not found' }],
        404
      );
    }

    if (booking.CustomerProfile?.userId !== userId) {
  throw new AppError(
    'Error.Forbidden',
    [{ path: ['userId'], message: 'Not allowed to view this transaction' }],
    403
  );
}

    return {
      ok: true,
      data: {
        kind: 'booking' as const,
        status: paymentRepo.mapBookingTxStatus(bookingTx.status),
        amount: bookingTx.amount,
        bookingId: bookingTx.bookingId,
        updatedAt: (bookingTx.paidAt ?? bookingTx.createdAt).toISOString(),
      },
    };
  }

  const payTx = await paymentRepo.getPaymentTxByReference(orderCode);
  if (!payTx) {
    throw new AppError(
      'Error.TransactionNotFound',
      [{ path: ['orderCode'], message: 'Transaction not found' }],
      404
    );
  }

  if (payTx.userId && payTx.userId !== userId) {
    throw new AppError(
      'Error.Forbidden',
      [{ path: ['userId'], message: 'Not allowed to view this transaction' }],
      403
    );
  }

  const unifiedStatus = paymentRepo.mapPaymentTxStatus(payTx.status);
  const kind = payTx.serviceRequestId ? ('service_request_deposit' as const) : ('topup' as const);

  return {
    ok: true,
    data: {
      kind,
      status: unifiedStatus,                
      amount: payTx.amountIn,
      serviceRequestId: payTx.serviceRequestId ?? undefined,
      userId: payTx.userId ?? undefined,
      updatedAt: payTx.transactionDate.toISOString(),
    },
  };
}

/**
 * Xử lý thủ công khi payment thành công (trường hợp webhook PayOS lỗi)
 */
export async function handlePayOSSuccessManual(orderCode: string) {
  return prisma.$transaction(async (tx) => {
    // 1) Booking transaction 
    const transaction = await tx.transaction.findUnique({ where: { orderCode } });
    if (transaction) {
      if (transaction.status !== PaymentStatus.PENDING) {
        return { message: "Booking transaction already handled" };
      }

      await tx.transaction.update({
        where: { orderCode },
        data: { status: PaymentStatus.PAID, paidAt: new Date() },
      });

      if (transaction.bookingId) {
        await tx.proposal.update({
          where: { bookingId: transaction.bookingId },
          data: { status: ProposalStatus.ACCEPTED },
        });
      }

      return { message: "Booking payment success" };
    }

    // 2) Wallet top-up
    const paymentTransaction = await tx.paymentTransaction.findFirst({
      where: { referenceNumber: orderCode },
    });
    if (!paymentTransaction) {
      throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
    }
    if (
      paymentTransaction.status !== PaymentTransactionStatus.PENDING &&
      paymentTransaction.status !== PaymentTransactionStatus.PROCESSING
    ) {
      return { message: "Wallet top-up already handled" };
    }

    await tx.paymentTransaction.update({
      where: { id: paymentTransaction.id },
      data: { status: PaymentTransactionStatus.SUCCESS },
    });

    if (paymentTransaction.userId) {
      await tx.wallet.update({
        where: { userId: paymentTransaction.userId },
        data: { balance: { increment: paymentTransaction.amountIn } },
      });
    }

    return { message: "Wallet top-up success" };
  });
}

/**
 * Xử lý thủ công khi payment thất bại (trường hợp webhook PayOS lỗi)
 */
export async function handlePayOSFailedManual(orderCode: string) {
  return prisma.$transaction(async (tx) => {
    // 1) Booking transaction
    const transaction = await tx.transaction.findUnique({ where: { orderCode } });
    if (transaction) {
      if (transaction.status !== PaymentStatus.PENDING) {
        return { message: "Booking transaction already handled" };
      }

      await tx.transaction.update({
        where: { orderCode },
        data: { status: PaymentStatus.FAILED },
      });

      return { message: "Booking payment failed" };
    }

    // 2) Wallet top-up
    const paymentTransaction = await tx.paymentTransaction.findFirst({
      where: { referenceNumber: orderCode },
    });
    if (!paymentTransaction) {
      throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
    }
    if (
      paymentTransaction.status !== PaymentTransactionStatus.PENDING &&
      paymentTransaction.status !== PaymentTransactionStatus.PROCESSING
    ) {
      return { message: "Wallet top-up already handled" };
    }

    await tx.paymentTransaction.update({
      where: { id: paymentTransaction.id },
      data: { status: PaymentTransactionStatus.FAILED },
    });

    return { message: "Wallet top-up failed" };
  });
}
