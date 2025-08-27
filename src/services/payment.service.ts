import { ZodError } from "zod";
import PayOS from "@payos/node";
import { CreateTransactionDto, WalletTopUpDto } from "../schemas/type";
import {
  CreateTransactionSchema,
  WalletTopUpSchema,
} from "../schemas/app.schema";
import { AppError } from "../handlers/error";
import {
  PaymentMethod,
  PaymentStatus,
  PaymentTransactionStatus,
  ProposalStatus,
  PrismaClient,
  BookingStatus,
  RequestStatus,
  Transaction,
} from "../generated/prisma";
import * as paymentRepo from "../repositories/payment.repository";
import { CheckoutResponseDataType } from "@payos/node/lib/type";
import { getConfig } from "./config.service";

// NOTE: Tốt nhất dùng 1 instance Prisma chung, nhưng giữ nguyên phong cách file này:
const prisma = new PrismaClient();

// Khởi tạo PayOS SDK (đúng bộ key của PayOS)
const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID!, // clientId của PayOS
  process.env.PAYOS_API_KEY!, // apiKey của PayOS
  process.env.PAYOS_CHECKSUM_KEY!, // checksumKey của PayOS
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
        422,
      );
    }
    throw new AppError(
      "Error.ValidationUnexpected",
      { message: "Unexpected validation error" },
      400,
    );
  }
}

/**
 * Gọi PayOS tạo payment link
 */
async function requestPayOS(
  orderCode: number,
  amount: number,
  description: string,
): Promise<CheckoutResponseDataType> {
  const clientUrl = "https://api.homecare360.space";
  if (!clientUrl) {
    throw new AppError(
      "Error.MissingEnv",
      {
        message:
          "Thiếu biến môi trường CLIENT_BASE_URL (base URL của client/app)",
      },
      500,
    );
  }

  const cancelUrl = `${clientUrl}/payments/status?orderCode=${orderCode}`;
  const returnUrl = `${clientUrl}/payments/status?orderCode=${orderCode}`;

  const payload = { orderCode, amount, description, cancelUrl, returnUrl };
  console.log("📦 Sending to PayOS:", payload);

  try {
    const res = await payos.createPaymentLink(payload);
    if (!res?.checkoutUrl)
      throw new Error("Không nhận được checkoutUrl từ PayOS");
    return res;
  } catch (err: any) {
    console.error(
      "🚨 PayOS Error:",
      err?.response?.data ?? err?.message ?? err,
    );
    throw new AppError(
      "Error.PayosAPI",
      {
        message: "Không thể tạo payment link từ PayOS",
        error: err?.response?.data ?? err?.message ?? err,
      },
      502,
    );
  }
}

export const createTransaction = async (data: CreateTransactionDto) => {
  validateOrThrow(CreateTransactionSchema, data);

  try {
    const amountVnd = Math.trunc(Number(data.amount));
    if (!Number.isFinite(amountVnd) || amountVnd <= 0) {
      throw new AppError(
        "Error.InvalidAmount",
        { message: "Invalid amount" },
        400,
      );
    }

    const paymentMethod = data.paymentMethod || PaymentMethod.BANK_TRANSFER;
    console.log("💳 Creating transaction with method:", paymentMethod);
    if (paymentMethod === PaymentMethod.WALLET) {
      return await handleWalletTransaction(data, amountVnd);
    } else if (paymentMethod === PaymentMethod.BANK_TRANSFER) {
      return await handleBankTransferTransaction(data, amountVnd);
    } else {
      throw new AppError(
        "Error.UnsupportedPaymentMethod",
        { message: "Payment method not supported", method: paymentMethod },
        400,
      );
    }
  } catch (error) {
    console.error("🚨 Error creating transaction:", error);
    throw new AppError(
      "Error.TransactionCreationFailed",
      { message: "Failed to create transaction", error },
      500,
    );
  }
};

/**
 * Xử lý giao dịch qua ví nội bộ
 */
async function handleWalletTransaction(
  data: CreateTransactionDto,
  amountVnd: number,
) {
  // Kiểm tra ví của user
  const wallet = await paymentRepo.findWalletByUserId(data.userId);
  if (!wallet) {
    throw new AppError(
      "Error.WalletNotFound",
      { message: "Wallet not found for user" },
      404,
    );
  }
  if (wallet.balance < amountVnd) {
    throw new AppError(
      "Error.InsufficientWalletBalance",
      {
        message: "Not enough balance to pay deposit.",
        currentBalance: wallet.balance,
        requiredAmount: amountVnd,
      },
      400,
    );
  }

  const description = `Thanh toán đặt cọc #${data.serviceRequestId}`;

  return prisma.$transaction(async (tx) => {
    const paymentTx = await paymentRepo.createPaymentTransaction({
      kind: "DEPOSIT",
      referenceNumber: `WALLET_${data.serviceRequestId}_${Date.now()}`,
      gateway: "INTERNAL_WALLET",
      status: PaymentTransactionStatus.SUCCESS,
      userId: data.userId,
      serviceRequestId: data.serviceRequestId,
      amount: amountVnd,
      description,
      body: JSON.stringify({
        method: PaymentMethod.WALLET,
        serviceRequestId: data.serviceRequestId,
        createdById: data.userId,
        paidViaWallet: true,
      }),
    });
    console.log("💳 Payment transaction created:", paymentTx);
    await tx.wallet.update({
      where: { userId: data.userId },
      data: { balance: { decrement: amountVnd } },
    });

    await tx.serviceRequest.update({
      where: { id: data.serviceRequestId },
      data: { status: RequestStatus.PENDING },
    });

    return {
      message: "Deposit payment completed via wallet",
      paymentTransactionId: paymentTx.id,
      referenceNumber: paymentTx.referenceNumber,
      status: paymentTx.status, // SUCCESS
      amountOut: paymentTx.amountOut, // = amountVnd
      gateway: paymentTx.gateway, // INTERNAL_WALLET
      transactionDate: paymentTx.transactionDate,
      userId: paymentTx.userId,
      serviceRequestId: data.serviceRequestId,
      paidViaWallet: true,
      walletBalanceAfter: wallet.balance - amountVnd,
    };
  });
}

/**
 * Xử lý giao dịch qua chuyển khoản ngân hàng (PayOS)
 */
async function handleBankTransferTransaction(
  data: CreateTransactionDto,
  amountVnd: number,
) {
  const orderCode = Number(
    `${data.serviceRequestId}${Date.now().toString().slice(-6)}`,
  );

  const description = `Thanh toán đặt cọc #${data.serviceRequestId}`;

  // Tạo payment link qua PayOS
  const responseData = await requestPayOS(orderCode, amountVnd, description);

  // Tạo PaymentTransaction với trạng thái PENDING
  const paymentTx = await paymentRepo.createPaymentTransaction({
    kind: "DEPOSIT",
    referenceNumber: String(orderCode),
    gateway: "PAYOS",
    status: PaymentTransactionStatus.PENDING,
    userId: data.userId,
    serviceRequestId: data.serviceRequestId,
    amount: amountVnd,
    description,
    body: JSON.stringify({
      method: PaymentMethod.BANK_TRANSFER,
      serviceRequestId: data.serviceRequestId,
      createdById: data.userId,
      orderCode: orderCode,
    }),
  });

  return {
    message: "Payment transaction created",
    paymentTransactionId: paymentTx.id,
    referenceNumber: paymentTx.referenceNumber,
    status: paymentTx.status, 
    amountOut: paymentTx.amountOut, 
    gateway: paymentTx.gateway, 
    transactionDate: paymentTx.transactionDate,
    userId: paymentTx.userId,
    serviceRequestId: data.serviceRequestId,
    responseData,
    checkoutUrl: responseData?.checkoutUrl,
    requiresPayment: true,
  };
}

/**
 * Tạo giao dịch nạp ví (bảng PaymentTransaction) + tạo link PayOS
 */
export const createWalletTopUpUsingPaymentTransaction = async (
  data: WalletTopUpDto,
) => {
  validateOrThrow(WalletTopUpSchema, data);

  try {
    const orderCode = Date.now();
    const amountVnd = Math.trunc(Number(data.amount));
    const minTopUpAmount = getConfig<number>("WALLET_TOPUP_MIN", 10000);
    if (!Number.isFinite(amountVnd) || amountVnd < minTopUpAmount) {
      throw new AppError(
        "Error.InvalidAmount",
        { message: `Số tiền nạp không hợp lệ. Vui lòng nạp tối thiểu ${minTopUpAmount} VND.` },
        400,
      );
    }

    const description = `Nạp tiền vào ví #${data.userId}`;

    // 1) Tạo  thanh toán PayOS
    const responseData = await requestPayOS(orderCode, amountVnd, description);

    // 2) Ghi  PaymentTransaction: TOPUP => amountIn = amount, amountOut = 0
    const paymentTx = await paymentRepo.createPaymentTransaction({
      kind: "TOPUP",
      referenceNumber: String(orderCode), // map orderCode -> referenceNumber
      gateway: "PAYOS",
      status: PaymentTransactionStatus.PENDING, // chờ callback
      userId: data.userId,
      amount: amountVnd,
      body: JSON.stringify({
        action: "WALLET_TOPUP",
        userId: data.userId,
      }),
    });

    return {
      message: "Top-up payment transaction created",
      paymentTransactionId: paymentTx.id,
      referenceNumber: paymentTx.referenceNumber,
      status: paymentTx.status,
      amountIn: paymentTx.amountIn, 
      gateway: paymentTx.gateway,
      transactionDate: paymentTx.transactionDate,
      userId: paymentTx.userId,
      responseData,
      checkoutUrl: responseData?.checkoutUrl,
    };
  } catch (error) {
    console.error("🚨 Error creating wallet top-up:", error);
    throw new AppError(
      "Error.WalletTopUpCreateFailed",
      { message: "Failed to create wallet top-up", error },
      500,
    );
  }
};


export const handlePayOSCallback = async (payload: {
  orderCode: string;
  status: "PAID" | "CANCELLED";
}) => {
  const { orderCode, status } = payload;

  return prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.findUnique({
      where: { orderCode },
      select: { id: true, orderCode: true, status: true, bookingId: true },
    });

    if (txn) {
      if (txn.status !== PaymentStatus.PENDING) {
        return { message: "Transaction already handled" };
      }

      if (status === "PAID") {
        await tx.transaction.update({
          where: { orderCode },
          data: { status: PaymentStatus.PAID, paidAt: new Date() },
        });

        if (!txn.bookingId) {
          throw new AppError("Error.InvalidBookingId", { orderCode }, 400);
        }

        // Proposal payment: chấp nhận proposal của booking này
        const proposal = await tx.proposal.findUnique({
          where: { bookingId: txn.bookingId },
          select: { id: true },
        });
        if (!proposal) {
          throw new AppError(
            "Error.ProposalNotFound",
            { orderCode, bookingId: txn.bookingId },
            404,
          );
        }

        await tx.proposal.update({
          where: { id: proposal.id },
          data: { status: ProposalStatus.ACCEPTED },
        });

        await tx.proposalItem.updateMany({
  where: { proposalId: proposal.id },
  data: { status: ProposalStatus.ACCEPTED },
});

        await tx.booking.update({
          where: { id: txn.bookingId },
          data: { status: BookingStatus.CONFIRMED },
        });

        return { message: "Proposal payment success handled" };
      }

      if (status === "CANCELLED") {
        await tx.transaction.update({
          where: { orderCode },
          data: { status: PaymentStatus.FAILED },
        });
        return { message: "Proposal payment failure handled" };
      }

      throw new AppError("Error.InvalidStatus", { status }, 400);
    }

    // 2) TH 2: Deposit/Top-up ở bảng PaymentTransaction (referenceNumber = orderCode)
    const paymentTx = await tx.paymentTransaction.findFirst({
      where: { referenceNumber: orderCode },
      select: {
        id: true,
        status: true,
        userId: true,
        amountIn: true,
        serviceRequestId: true,
      },
    });

    if (!paymentTx) {
      throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
    }

    // Đã xử lý?
    if (
      paymentTx.status !== PaymentTransactionStatus.PENDING &&
      paymentTx.status !== PaymentTransactionStatus.PROCESSING
    ) {
      return {
        message:
          "Payment transaction already handled or in an unchangeable state",
      };
    }

    if (status === "PAID") {
      // Đánh dấu SUCCESS trước
      await tx.paymentTransaction.update({
        where: { id: paymentTx.id },
        data: { status: PaymentTransactionStatus.SUCCESS },
      });

      // Phân nhánh theo TOPUP / DEPOSIT
      if (paymentTx.serviceRequestId == null) {
        // TOPUP: cộng ví
        if (paymentTx.userId) {
          await tx.wallet.update({
            where: { userId: paymentTx.userId },
            data: { balance: { increment: paymentTx.amountIn } },
          });
        }
        return { message: "Wallet top-up success handled" };
      } else {
        await tx.serviceRequest.update({
          where: { id: paymentTx.serviceRequestId },
          data: { status: RequestStatus.PENDING },
        });

        return { message: "Deposit payment success handled" };
      }
    }

    if (status === "CANCELLED") {
      await tx.paymentTransaction.update({
        where: { id: paymentTx.id },
        data: { status: PaymentTransactionStatus.FAILED },
      });
      return {
        message:
          paymentTx.serviceRequestId == null
            ? "Wallet top-up failure handled"
            : "Deposit payment failure handled",
      };
    }

    throw new AppError("Error.InvalidStatus", { status }, 400);
  });
};



export const createProposalPayment = async ({
  bookingId,
  method,
  userId,
}: {
  bookingId: number;
  method?: PaymentMethod;
  userId: number;
}) => {
  const proposal =
    await paymentRepo.findProposalByBookingIdWithItems(bookingId);
  if (!proposal) {
    throw new AppError(
      "Error.ProposalNotFound",
      { message: `No proposal for booking #${bookingId}` },
      404,
    );
  }

  const acceptedItems = proposal.ProposalItem.filter(
    (item) => item.status === "PENDING",
  );
  if (acceptedItems.length === 0) {
    throw new AppError(
      "Error.NoPendingProposalItem",
      { message: `No PENDING proposal items for booking #${bookingId}` },
      400,
    );
  }

  const bookingDeposit = getConfig<number>("BOOKING_DEPOSIT", 30000);

  const rawAmount =
    acceptedItems.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0,
    ) - bookingDeposit;


  console.log("Raw amount (ACCEPTED only):", rawAmount);

  const amountVnd = Math.trunc(Number(rawAmount));
  if (!Number.isFinite(amountVnd) || amountVnd <= 0) {
    throw new AppError(
      "Error.InvalidAmount",
      { message: "Invalid proposal amount" },
      400,
    );
  }

  const paymentMethod = method;

  if (paymentMethod === PaymentMethod.WALLET) {
    const transaction = await paymentRepo.payProposalWithWalletAtomic(
      userId,
      bookingId,
      amountVnd,
    );

    return {
      message: "Proposal paid via wallet",
      transactionId: transaction.id,
      orderCode: transaction.orderCode,
      status: transaction.status,
      amount: transaction.amount,
      method: transaction.method,
      paidAt: transaction.paidAt,
      bookingId,
    };
  }

  const orderCode = Number(`${bookingId}${Date.now().toString().slice(-6)}`);
  const description = `Thanh toán proposal #${bookingId}`;
  const responseData = await requestPayOS(orderCode, amountVnd, description);

  const tx = await paymentRepo.upsertBookingTransaction({
    bookingId,
    amount: amountVnd,
    method: PaymentMethod.BANK_TRANSFER,
    orderCode: String(orderCode),
    createdById: userId,
  });

  return {
    message: "Proposal payment initiated",
    transactionId: tx.id,
    bookingId: tx.bookingId,
    amount: tx.amount,
    method: tx.method,
    status: tx.status as PaymentStatus,
    createdAt: tx.createdAt,
    orderCode: String(orderCode),
    responseData,
    checkoutUrl: responseData?.checkoutUrl,
  };
};


export async function getPaymentStatus(orderCode: string) {
  if (!orderCode || typeof orderCode !== "string") {
    throw new AppError(
      "Error.InvalidOrderCode",
      [{ path: ["orderCode"], message: "orderCode is required (string)" }],
      400,
    );
  }

  const bookingTx = await paymentRepo.getBookingTxWithOwner(orderCode);
  if (bookingTx) {
    const booking = bookingTx.Booking;
    if (!booking) {
      throw new AppError(
        "Error.BookingNotFound",
        [{ path: ["booking"], message: "Booking not found" }],
        404,
      );
    }

    return {
      ok: true,
      data: {
        kind: "booking" as const,
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
      "Error.TransactionNotFound",
      [{ path: ["orderCode"], message: "Transaction not found" }],
      404,
    );
  }

  const unifiedStatus = paymentRepo.mapPaymentTxStatus(payTx.status);
  const kind = payTx.serviceRequestId
    ? ("service_request_deposit" as const)
    : ("topup" as const);

  return {
    ok: true,
    data: {
      kind,
      status: unifiedStatus,
      amount: payTx.amountIn,
      serviceRequestId: payTx.serviceRequestId ?? undefined,
      updatedAt: payTx.transactionDate.toISOString(),
    },
  };
}

 /**
 * Thanh toán cho service request đã tồn tại
 */
export const payExistingServiceRequest = async ({
  serviceRequestId,
  userId,
  paymentMethod = PaymentMethod.BANK_TRANSFER,
  amount,
}: {
  serviceRequestId: number;
  userId: number;
  paymentMethod?: PaymentMethod;
  amount: number;
}) => {
  try {
    const amountVnd = Math.trunc(Number(amount));
    if (!Number.isFinite(amountVnd) || amountVnd <= 0) {
      throw new AppError(
        "Error.InvalidAmount",
        { message: "Invalid amount" },
        400,
      );
    }

    const serviceRequest = await prisma.serviceRequest.findFirst({
      where: {
        id: serviceRequestId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!serviceRequest) {
      throw new AppError(
        "Error.ServiceRequestNotFound",
        {
          message: "Service request not found or access denied",
          serviceRequestId,
        },
        404,
      );
    }

    if (serviceRequest.status !== RequestStatus.WAIT_FOR_PAYMENT) {
      throw new AppError(
        "Error.InvalidServiceRequestStatus",
        {
          message: "Service request is not in payable state",
          currentStatus: serviceRequest.status,
          serviceRequestId,
        },
        400,
      );
    }

    const existingPaymentTx = await prisma.paymentTransaction.findFirst({
      where: {
        serviceRequestId: serviceRequestId,
        status: {
          in: [
            PaymentTransactionStatus.PENDING,
            PaymentTransactionStatus.PROCESSING,
          ],
        },
      },
      select: { id: true, status: true, referenceNumber: true },
    });

    if (existingPaymentTx) {
      throw new AppError(
        "Error.PaymentAlreadyInProgress",
        {
          message: "A payment is already in progress for this service request",
          existingTransactionId: existingPaymentTx.id,
          referenceNumber: existingPaymentTx.referenceNumber,
        },
        409,
      );
    }

    console.log(
      "💳 Paying existing service request with method:",
      paymentMethod,
    );

    if (paymentMethod === PaymentMethod.WALLET) {
      return await handleExistingServiceRequestWalletPayment(
        serviceRequestId,
        userId,
        amountVnd,
      );
    } else if (paymentMethod === PaymentMethod.BANK_TRANSFER) {
      return await handleExistingServiceRequestBankTransferPayment(
        serviceRequestId,
        userId,
        amountVnd,
      );
    } else {
      throw new AppError(
        "Error.UnsupportedPaymentMethod",
        { message: "Payment method not supported", method: paymentMethod },
        400,
      );
    }
  } catch (error) {
    console.error("🚨 Error paying existing service request:", error);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      "Error.PaymentFailed",
      { message: "Failed to process payment for service request", error },
      500,
    );
  }
};

/**
 * Xử lý thanh toán service request bằng ví nội bộ
 */
async function handleExistingServiceRequestWalletPayment(
  serviceRequestId: number,
  userId: number,
  amountVnd: number,
) {
  // Kiểm tra ví của user
  const wallet = await paymentRepo.findWalletByUserId(userId);
  if (!wallet) {
    throw new AppError(
      "Error.WalletNotFound",
      { message: "Wallet not found for user" },
      404,
    );
  }
  if (wallet.balance < amountVnd) {
    throw new AppError(
      "Error.InsufficientWalletBalance",
      {
        message: "Not enough balance to pay for service request.",
        currentBalance: wallet.balance,
        requiredAmount: amountVnd,
      },
      400,
    );
  }

  const description = `Thanh toán service request #${serviceRequestId}`;

  return prisma.$transaction(async (tx) => {
    // 1. Tạo PaymentTransaction SUCCESS
    const paymentTx = await paymentRepo.createPaymentTransaction({
      kind: "DEPOSIT",
      referenceNumber: `WALLET_SR_${serviceRequestId}_${Date.now()}`,
      gateway: "INTERNAL_WALLET",
      status: PaymentTransactionStatus.SUCCESS,
      userId: userId,
      serviceRequestId: serviceRequestId,
      amount: amountVnd,
      description,
      body: JSON.stringify({
        method: PaymentMethod.WALLET,
        serviceRequestId: serviceRequestId,
        createdById: userId,
        paidViaWallet: true,
      }),
    });

    // 2. Trừ tiền trong ví
    await tx.wallet.update({
      where: { userId: userId },
      data: { balance: { decrement: amountVnd } },
    });

    // 3. Cập nhật ServiceRequest thành PENDING hoặc CONFIRMED tùy business logic
    await tx.serviceRequest.update({
      where: { id: serviceRequestId },
      data: {
        status: RequestStatus.PENDING, // hoặc CONFIRMED tùy yêu cầu
      },
    });

    // 4. Trả về kết quả
    return {
      message: "Service request payment completed via wallet",
      paymentTransactionId: paymentTx.id,
      referenceNumber: paymentTx.referenceNumber,
      status: paymentTx.status,
      amountOut: paymentTx.amountOut,
      gateway: paymentTx.gateway,
      transactionDate: paymentTx.transactionDate,
      userId: paymentTx.userId,
      serviceRequestId: serviceRequestId,
      paidViaWallet: true,
      walletBalanceAfter: wallet.balance - amountVnd,
    };
  });
}

/**
 * Xử lý thanh toán service request qua chuyển khoản ngân hàng (PayOS)
 */
async function handleExistingServiceRequestBankTransferPayment(
  serviceRequestId: number,
  userId: number,
  amountVnd: number,
) {
  const orderCode = Number(
    `${serviceRequestId}${Date.now().toString().slice(-6)}`,
  );

  const description = `Thanh toán service request #${serviceRequestId}`;

  // Tạo payment link qua PayOS
  const responseData = await requestPayOS(orderCode, amountVnd, description);

  // Tạo PaymentTransaction với trạng thái PENDING
  const paymentTx = await paymentRepo.createPaymentTransaction({
    kind: "DEPOSIT",
    referenceNumber: String(orderCode),
    gateway: "PAYOS",
    status: PaymentTransactionStatus.PENDING,
    userId: userId,
    serviceRequestId: serviceRequestId,
    amount: amountVnd,
    description,
    body: JSON.stringify({
      method: PaymentMethod.BANK_TRANSFER,
      serviceRequestId: serviceRequestId,
      createdById: userId,
      orderCode: orderCode,
    }),
  });

  return {
    message: "Service request payment transaction created",
    paymentTransactionId: paymentTx.id,
    referenceNumber: paymentTx.referenceNumber,
    status: paymentTx.status,
    amountOut: paymentTx.amountOut,
    gateway: paymentTx.gateway,
    transactionDate: paymentTx.transactionDate,
    userId: paymentTx.userId,
    serviceRequestId: serviceRequestId,
    responseData,
    checkoutUrl: responseData?.checkoutUrl,
    requiresPayment: true,
  };
}
