import PayOS from "@payos/node";
import { ZodError } from "zod";
import { CreateTransactionDto, WalletTopUpDto } from "../schemas/type";
import { CreateTransactionSchema, WalletTopUpSchema } from "../schemas/app.schema";
import { AppError } from "../handlers/error";
import { PaymentMethod, PaymentStatus, PaymentTransactionStatus } from "../generated/prisma"; // Import PaymentTransactionStatus
import * as paymentRepo from "../repositories/payment.repository";
import { CheckoutResponseDataType } from "@payos/node/lib/type";

const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID!,
  process.env.PAYOS_API_KEY!,
  process.env.PAYOS_CHECKSUM_KEY!
);

/**
 * Validates data against a Zod schema and throws an AppError if validation fails.
 * @param schema The Zod schema to validate against.
 * @param data The data to validate.
 * @throws {AppError} If validation fails.
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
 * Requests a payment link from PayOS.
 * Dynamically sets cancelUrl and returnUrl based on clientType (web or native).
 * @param orderCode The unique order code for the payment.
 * @param amount The amount of the transaction.
 * @param description A description for the payment.
 * @param clientType The type of client initiating the request ('web' or 'native').
 * @returns The checkout URL from PayOS.
 * @throws {AppError} If there's an issue creating the payment link with PayOS.
 */
async function requestPayOS(
  orderCode: string,
  amount: number,
  description: string,
  clientType: 'web' | 'native'
): Promise<CheckoutResponseDataType> {
  try {
    let cancelUrl: string;
    let returnUrl: string;

    if (clientType === 'native') {
      // For native apps, use deep links
      // Ensure NATIVE_APP_SCHEME is configured in your .env (e.g., myapp://)
      // And your native app is set up to handle these deep links
      const nativeAppScheme = process.env.NATIVE_APP_SCHEME || 'yourappscheme'; // Default for safety
      cancelUrl = `${nativeAppScheme}://payment/cancel?orderCode=${orderCode}`;
      returnUrl = `${nativeAppScheme}://payment/success?orderCode=${orderCode}`;
    } else {
      // For web apps, use standard web URLs
      cancelUrl = `${process.env.CLIENT_URL}/payment/cancel`;
      returnUrl = `${process.env.CLIENT_URL}/payment/success?orderCode=${orderCode}`;
    }

    const payload = {
      orderCode: Number(orderCode), // PayOS expects orderCode as a number in this context
      amount,
      description,
      cancelUrl,
      returnUrl,
    };

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
 * Creates a new transaction and initiates a payment link with PayOS.
 * @param data The transaction data.
 * @param clientType The type of client initiating the request ('web' or 'native').
 * @returns An object containing transaction details and the PayOS checkout URL.
 */
export const createTransaction = async (data: CreateTransactionDto, clientType: 'web' | 'native') => {
  validateOrThrow(CreateTransactionSchema, data);

  // Generate a unique order code using bookingId and current timestamp
  const orderCode = `${data.bookingId}-${Date.now()}`;
  const description = `Thanh toán đơn hàng #${data.bookingId}`;
  const checkoutUrl = await requestPayOS(orderCode, data.amount, description, clientType);

  // Create a transaction record in the database
  const transaction = await paymentRepo.createTransaction({
    bookingId: data.bookingId,
    amount: data.amount,
    method: PaymentMethod.CREDIT_CARD, // Assuming credit card for PayOS
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

/**
 * Creates a payment transaction for wallet top-up and initiates a payment link with PayOS.
 * @param data The wallet top-up data.
 * @param clientType The type of client initiating the request ('web' or 'native').
 * @returns An object containing the PayOS checkout URL.
 */
export const createWalletTopUpUsingPaymentTransaction = async (data: WalletTopUpDto, clientType: 'web' | 'native') => {
  validateOrThrow(WalletTopUpSchema, data);

  // Generate a unique order code for the top-up
  const orderCode = `TOPUP-${data.userId}-${Date.now()}`;
  const description = `Nạp tiền vào ví #${data.userId}`;
  const checkoutUrl = await requestPayOS(orderCode, data.amount, description, clientType);

  // Create a payment transaction record in the database
  await paymentRepo.createPaymentTransaction({
    amount: data.amount,
    userId: data.userId,
    orderCode: orderCode.toString(),
    gateway: "PAYOS",
    status: PaymentTransactionStatus.PENDING,
  });

  return { checkoutUrl };
};

/**
 * Handles the callback from PayOS after a payment attempt.
 * Updates the status of the corresponding transaction or payment transaction.
 * @param payload The payload received from PayOS callback.
 * @returns A message indicating the outcome of the handling.
 * @throws {AppError} If the transaction or payment transaction is not found or status is invalid.
 */
export const handlePayOSCallback = async (payload: {
  orderCode: string;
  status: "PAID" | "FAILED";
}) => {
  const { orderCode, status } = payload;

  // Try to find a regular booking transaction first
  const transaction = await paymentRepo.findTransactionByOrderCode(orderCode);

  if (transaction) {
    if (transaction.status !== PaymentStatus.PENDING) {
      return { message: "Transaction already handled" };
    }

    if (status === "PAID") {
      await paymentRepo.markTransactionAsPaid(orderCode);
      if (!transaction.bookingId || transaction.bookingId === 0) {
        if (transaction.createdById !== null) {
          await paymentRepo.topUpWallet(transaction.createdById, transaction.amount);
        } else {
          console.warn(`Transaction ${orderCode} has null createdById, cannot top up wallet.`);
        }
      }
      return { message: "Payment success handled" };
    }

    if (status === "FAILED") {
      await paymentRepo.markTransactionAsFailed(orderCode);
      return { message: "Payment failure handled" };
    }
  } else {
    // If not a regular booking transaction, try to find a PaymentTransaction (for top-ups)
    const paymentTransaction = await paymentRepo.findPaymentTransactionByReference(orderCode);

    if (!paymentTransaction) {
      throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
    }

    if (paymentTransaction.status !== PaymentTransactionStatus.PENDING) {
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
