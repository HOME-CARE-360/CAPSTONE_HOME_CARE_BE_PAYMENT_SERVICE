import PayOS from "@payos/node";
import { ZodError } from "zod";
import { CreateTransactionDto, WalletTopUpDto } from "../schemas/type";
import { CreateTransactionSchema, WalletTopUpSchema } from "../schemas/app.schema";
import { AppError } from "../handlers/error";
import { PaymentMethod, PaymentStatus } from "../generated/prisma";
import * as paymentRepo from "../repositories/payment.repository";

const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID!,
  process.env.PAYOS_API_KEY!,
  process.env.PAYOS_CHECKSUM_KEY!
);

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

async function requestPayOS(orderCode: number, amount: number, description: string): Promise<string> {
  try {
    const payload = {
      orderCode,
      amount,
      description,
      cancelUrl: `${process.env.CLIENT_URL}/payment/cancel`,
      returnUrl: `${process.env.CLIENT_URL}/payment/success?orderCode=${orderCode}`,
    };

    const res = await payos.createPaymentLink(payload);
    if (!res?.checkoutUrl) {
      throw new Error("Không nhận được checkoutUrl từ PayOS");
    }

    return res.checkoutUrl;
  } catch (err: any) {
    console.error("🚨 PayOS Error:", err?.response?.data || err.message || err);
    throw new AppError("Error.PayosAPI", {
      message: "Không thể tạo payment link từ PayOS",
      error: err?.response?.data || err.message || err,
    }, 502);
  }
}

export const createTransaction = async (data: CreateTransactionDto) => {
  validateOrThrow(CreateTransactionSchema, data);

  const orderCode = Number(`${data.bookingId}${Date.now()}`);
  const description = `Thanh toán đơn hàng #${data.bookingId}`;
  const checkoutUrl = await requestPayOS(orderCode, data.amount, description);

  const transaction = await paymentRepo.createTransaction({
    bookingId: data.bookingId,
    amount: data.amount,
    method: PaymentMethod.CREDIT_CARD,
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
    checkoutUrl,
  };
};

export const createWalletTopUpUsingPaymentTransaction = async (data: WalletTopUpDto) => {
  validateOrThrow(WalletTopUpSchema, data);

  const orderCode = Number(`${data.userId}${Date.now()}`);
  const description = `Nạp tiền vào ví #${data.userId}`;
  const checkoutUrl = await requestPayOS(orderCode, data.amount, description);

  await paymentRepo.createPaymentTransaction({
    amount: data.amount,
    userId: data.userId,
    orderCode: orderCode.toString(),
    gateway: "PAYOS",
    status: PaymentStatus.PENDING,
  });

  return { checkoutUrl };
};

export const handlePayOSCallback = async (payload: {
  orderCode: string;
  status: "PAID" | "FAILED";
}) => {
  const { orderCode, status } = payload;

  const transaction = await paymentRepo.findTransactionByOrderCode(orderCode);
  if (transaction) {
    if (transaction.status !== PaymentStatus.PENDING) {
      return { message: "Transaction already handled" };
    }

    if (status === "PAID") {
      await paymentRepo.markTransactionAsPaid(orderCode);
      if (!transaction.bookingId || transaction.bookingId === 0) {
        await paymentRepo.topUpWallet(transaction.createdById!, transaction.amount);
      }
      return { message: "Payment success handled" };
    }

    if (status === "FAILED") {
      await paymentRepo.markTransactionAsFailed(orderCode);
      return { message: "Payment failure handled" };
    }
  } else {
    const paymentTransaction = await paymentRepo.findPaymentTransactionByReference(orderCode);
    if (!paymentTransaction) {
      throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
    }

    if (paymentTransaction.status !== PaymentStatus.PENDING) {
      return { message: "PaymentTransaction already handled" };
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
  }

  throw new AppError("Error.InvalidStatus", { status }, 400);
};
