import PayOS from "@payos/node";
import { ZodError } from "zod";
import { CreateTransactionDto, WalletTopUpDto } from "../schemas/type";
import { CreateTransactionSchema, WalletTopUpSchema } from "../schemas/app.schema";
import { AppError } from "../handlers/error";
import { PaymentMethod, PaymentStatus, PaymentTransactionStatus } from "../generated/prisma";
import * as paymentRepo from "../repositories/payment.repository";
import { CheckoutResponseDataType } from "@payos/node/lib/type";

const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID!,
  process.env.PAYOS_API_KEY!,
  process.env.PAYOS_CHECKSUM_KEY!
);

/**
 * Validates data against a Zod schema and throws an AppError if validation fails.
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
 * Sends a payment link request to PayOS.
 */
async function requestPayOS(
  orderCode: number,
  amount: number,
  description: string
): Promise<CheckoutResponseDataType> {
  const clientUrl = process.env.PAYOS_CLIENT_ID;
  if (!clientUrl) {
    throw new AppError("Error.MissingEnv", {
      message: "Missing PAYOS_CLIENT_ID environment variable",
    }, 500);
  }

  const cancelUrl = `${clientUrl}/payment/cancel`;
  const returnUrl = `${clientUrl}/payment/success?orderCode=${orderCode}`;

  const payload = {
    orderCode,
    amount,
    description,
    cancelUrl,
    returnUrl,
  };

  console.log("📦 Sending to PayOS:", payload);

  try {
    const res = await payos.createPaymentLink(payload);

    if (!res?.checkoutUrl) {
      throw new Error("Không nhận được checkoutUrl từ PayOS");
    }

    return res;
  } catch (err: any) {
    console.error("🚨 PayOS Error:", err?.response?.data || err.message || err);
    throw new AppError("Error.PayosAPI", {
      message: "Không thể tạo payment link từ PayOS",
      error: err?.response?.data || err.message || err,
    }, 502);
  }
}

/**
 * Creates a booking payment transaction and generates PayOS link.
 */
export const createTransaction = async (data: CreateTransactionDto) => {
  validateOrThrow(CreateTransactionSchema, data);

  const orderCode = Number(`${data.bookingId}${Date.now().toString().slice(-6)}`); // Safe numeric code
  const description = `Thanh toán đơn hàng #${data.bookingId}`;
  const responseData = await requestPayOS(orderCode, data.amount, description);

  const transaction = await paymentRepo.createTransaction({
    bookingId: data.bookingId,
    amount: data.amount,
    method:data.method || PaymentMethod.BANK_TRANSFER,
    orderCode: orderCode.toString(), // Save as string in DB
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
 * Creates a wallet top-up transaction and generates PayOS link.
 */
export const createWalletTopUpUsingPaymentTransaction = async (data: WalletTopUpDto) => {
  validateOrThrow(WalletTopUpSchema, data);

  const orderCode = Date.now(); // Unique and numeric
  const description = `Nạp tiền vào ví #${data.userId}`;
  const responseData = await requestPayOS(orderCode, data.amount, description);

  await paymentRepo.createPaymentTransaction({
    amount: data.amount,
    userId: data.userId,
    orderCode: orderCode.toString(),
    gateway: "PAYOS",
    status: PaymentTransactionStatus.PENDING,
  });

  return { responseData };
};

/**
 * Handles PayOS callback (PAID or FAILED).
 */
export const handlePayOSCallback = async (payload: { orderCode: string; status: "PAID" | "FAILED" }) => {
  const { orderCode, status } = payload;
  const transaction = await paymentRepo.findTransactionByOrderCode(orderCode);

  if (transaction) {
    if (transaction.status !== PaymentStatus.PENDING) {
      return { message: "Transaction already handled" };
    }

    if (status === "PAID") {
      await paymentRepo.markTransactionAsPaid(orderCode);

      if (!transaction.bookingId || transaction.bookingId === 0) {
        if (transaction.createdById) {
          await paymentRepo.topUpWallet(transaction.createdById, transaction.amount);
        } else {
          console.warn(`Transaction ${orderCode} missing createdById for wallet top-up`);
        }
      }

      return { message: "Booking payment success handled" };
    }

    if (status === "FAILED") {
      await paymentRepo.markTransactionAsFailed(orderCode);
      return { message: "Booking payment failure handled" };
    }
  }

  // Try wallet top-up
  const paymentTransaction = await paymentRepo.findPaymentTransactionByReference(orderCode);

  if (!paymentTransaction) {
    throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
  }

  if (paymentTransaction.status !== PaymentTransactionStatus.PENDING) {
    return { message: "Wallet top-up already handled" };
  }

  if (status === "PAID") {
    await paymentRepo.markPaymentTransactionAsPaid(orderCode);
    if (paymentTransaction.userId) {
      await paymentRepo.topUpWallet(paymentTransaction.userId, paymentTransaction.amountIn);
    }
    return { message: "Wallet top-up success handled" };
  }

  if (status === "FAILED") {
    await paymentRepo.markPaymentTransactionAsFailed(orderCode);
    return { message: "Wallet top-up failure handled" };
  }

  throw new AppError("Error.InvalidStatus", { status }, 400);
};
