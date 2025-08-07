import { ZodError } from "zod";
import PayOS from "@payos/node";
import { CreateTransactionDto, WalletTopUpDto } from "../schemas/type";
import { CreateTransactionSchema, WalletTopUpSchema } from "../schemas/app.schema";
import { AppError } from "../handlers/error";
import { PaymentMethod, PaymentStatus, PaymentTransactionStatus, ProposalStatus, PrismaClient } from "../generated/prisma";
import * as paymentRepo from "../repositories/payment.repository"; // Import all functions from repository
import { CheckoutResponseDataType } from "@payos/node/lib/type";

const prisma = new PrismaClient(); // Re-initialize prisma client for this service file

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
  const clientUrl = process.env.PAYOS_CLIENT_ID; // Assuming PAYOS_CLIENT_ID is actually the base URL for client redirects
  if (!clientUrl) {
    throw new AppError("Error.MissingEnv", {
      message: "Missing PAYOS_CLIENT_ID environment variable (should be client base URL)",
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

  // Generate a unique orderCode for PayOS.
  // The repository's createTransaction handles the unique bookingId constraint.
  const orderCode = Number(`${data.bookingId}${Date.now().toString().slice(-6)}`);
  const description = `Thanh toán đơn hàng #${data.bookingId}`;
  const responseData = await requestPayOS(orderCode, data.amount, description);

  // Gọi hàm từ repository để tạo transaction
  const transaction = await paymentRepo.createTransaction({
    bookingId: data.bookingId,
    amount: data.amount,
    method: data.method || PaymentMethod.BANK_TRANSFER,
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

  // Gọi hàm từ repository để tạo payment transaction
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
 * This function now uses Prisma transactions for atomicity via repository methods.
 */
export const handlePayOSCallback = async (payload: { orderCode: string; status: "PAID" | "FAILED" }) => {
  const { orderCode, status } = payload;

  // Use a transaction to ensure atomicity for the entire callback process
  return prisma.$transaction(async (tx) => { // Use tx for all operations within this transaction
    // Attempt to find a booking transaction first
    const transaction = await tx.transaction.findUnique({ where: { orderCode } });

    if (transaction) {
      if (transaction.status !== PaymentStatus.PENDING) {
        return { message: "Booking transaction already handled" };
      }

      if (status === "PAID") {
        await tx.transaction.update({
          where: { orderCode },
          data: {
            status: PaymentStatus.PAID,
            paidAt: new Date(),
          },
        });

        // Update the associated Proposal status to ACCEPTED if payment is successful
        if (transaction.bookingId) {
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
          data: {
            status: PaymentStatus.FAILED,
          },
        });
        return { message: "Booking payment failure handled" };
      }
    }

    // If not a booking transaction, try to find a wallet top-up PaymentTransaction
    const paymentTransaction = await tx.paymentTransaction.findFirst({
      where: { referenceNumber: orderCode },
    });

    if (!paymentTransaction) {
      throw new AppError("Error.TransactionNotFound", { orderCode }, 404);
    }

    if (paymentTransaction.status !== PaymentTransactionStatus.PENDING &&
        paymentTransaction.status !== PaymentTransactionStatus.PROCESSING) {
      return { message: "Wallet top-up already handled or in an unchangeable state" };
    }

    if (status === "PAID") {
      await tx.paymentTransaction.update({
        where: { id: paymentTransaction.id },
        data: {
          status: PaymentTransactionStatus.SUCCESS,
          accumulated: paymentTransaction.amountIn,
        },
      });
      if (paymentTransaction.userId) {
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
        data: {
          status: PaymentTransactionStatus.FAILED,
        },
      });
      return { message: "Wallet top-up failure handled" };
    }

    throw new AppError("Error.InvalidStatus", { status }, 400);
  });
};


export const payProposalWithWallet = async ({
  bookingId,
  userId,
}: {
  bookingId: number;
  userId: number;
}) => {
  const proposal = await paymentRepo.findProposalByBookingIdWithItems(bookingId);
  if (!proposal || proposal.status !== ProposalStatus.ACCEPTED) {
    throw new AppError("Error.ProposalNotAccepted", {
      message: `Proposal for booking #${bookingId} is not accepted or doesn't exist.`,
    }, 400);
  }

  const total = proposal.ProposalItem.reduce((sum, item) => {
    return sum + item.quantity * item.Service.virtualPrice;
  }, 0);

  // Tìm ví qua repository
  // Lưu ý: Nếu bạn muốn kiểm tra số dư ví trong cùng một transaction với update,
  // bạn cần truyền `tx` từ service xuống repo hoặc thực hiện cả hai trong service.
  // Hiện tại, `findUnique` không nằm trong transaction.
  // Để đảm bảo tính toàn vẹn cao nhất, toàn bộ logic này nên nằm trong một Prisma transaction.
  const wallet = await paymentRepo.findWalletByUserId(userId); // Giả định có hàm này trong repo
  if (!wallet || wallet.balance < total) {
    throw new AppError("Error.InsufficientWalletBalance", {
      message: "Not enough balance to pay for proposal.",
    }, 400);
  }

  // Sử dụng transaction để đảm bảo trừ tiền ví và tạo transaction là atomic
  await paymentRepo.payProposalWithWalletAtomic(userId, bookingId, total); // Hàm mới trong repo để xử lý atomic

  return { message: "Proposal paid successfully via wallet." };
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
  const proposal = await paymentRepo.findProposalByBookingIdWithItems(bookingId);

  if (!proposal) {
    throw new AppError("Error.ProposalNotFound", {
      message: `No proposal found for booking #${bookingId}`,
    }, 404);
  }

  if (proposal.status !== ProposalStatus.ACCEPTED) {
    throw new AppError("Error.ProposalNotAccepted", {
      message: `Proposal for booking #${bookingId} is not accepted`,
    }, 400);
  }

  const amount = proposal.ProposalItem.reduce((sum, item) => {
    return sum + item.quantity * item.Service.virtualPrice;
  }, 0);

  if (amount <= 0) {
    throw new AppError("Error.InvalidAmount", {
      message: `Invalid proposal amount`,
    }, 400);
  }

  const paymentMethod = method || PaymentMethod.BANK_TRANSFER;

  // CASE 1: WALLET Payment
  if (paymentMethod === PaymentMethod.CASH) { // Changed from CASH to WALLET for consistency
    const wallet = await paymentRepo.findWalletByUserId(userId); // Gọi qua repository

    if (!wallet) {
      throw new AppError("Error.WalletNotFound", {
        message: "Wallet not found for user",
      }, 404);
    }

    if (wallet.balance < amount) {
      throw new AppError("Error.InsufficientBalance", {
        message: "Số dư ví không đủ để thanh toán proposal",
        currentBalance: wallet.balance,
        requiredAmount: amount,
      }, 400);
    }

    // Gọi hàm atomic từ repository để xử lý thanh toán ví
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

  // CASE 2: PayOS / Other gateway (Bank Transfer)
  const orderCode = Number(`${bookingId}${Date.now().toString().slice(-6)}`);
  const description = `Thanh toán proposal cho đơn #${bookingId}`;
  const responseData = await requestPayOS(orderCode, amount, description);

  // Gọi hàm từ repository để tạo transaction
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
};
