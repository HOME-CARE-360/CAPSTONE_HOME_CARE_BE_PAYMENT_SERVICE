import PayOS from "@payos/node";
import { CreateTransactionDto } from "../schemas/type";
import { CreateTransactionSchema } from "../schemas/app.schema";
import { AppError } from "../handlers/error";
import { ZodError } from "zod";
import { PaymentMethod } from "../generated/prisma";
import * as paymentRepo from "../repositories/payment.repository";
import { create } from "axios";

/**
 * Khởi tạo PayOS SDK
 */
const payos = new PayOS(
    process.env.PAYOS_CLIENT_ID!,
    process.env.PAYOS_API_KEY!,
    process.env.PAYOS_CHECKSUM_KEY!
);

/**
 * Validate đầu vào bằng Zod
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
 * Gọi PayOS để tạo link thanh toán
 */
async function requestPayOS(orderCode: number, amount: number, bookingId: number) {
    try {
        const payload = {
            orderCode,
            amount,
            description: `Thanh toán đơn hàng #${bookingId}`,
            cancelUrl: `${process.env.CLIENT_URL}/payment/cancel`,
            returnUrl: `${process.env.CLIENT_URL}/payment/success`,
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

/**
 * Create a payment transaction (PayOS + DB)
 */
export const createTransaction = async (data: CreateTransactionDto) => {
    validateOrThrow(CreateTransactionSchema, data);

    const orderCode = Number(`${data.bookingId}${Date.now()}`);
    const checkoutUrl = await requestPayOS(orderCode, data.amount, data.bookingId);

    try {
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
    } catch (err) {
        throw new AppError("Error.CreateTransactionFailed", {
            message: "Lỗi khi lưu transaction vào cơ sở dữ liệu",
        }, 500);
    }
};
