// FIX: Corrected import path for AppError
import { AppError } from "../handlers/error";
import {
  TCPResponseError,
  TCPResponseSuccess,
} from "../interfaces/tcp-response.interface";
import {
  CreateTransactionDto,
  // UpdateTransactionStatusDto, // Not used in this handler
  WalletTopUpDto,
} from "../schemas/type";
import * as paymentService from "../services/payment.service";

type HandleTCPReturn<T = any> = TCPResponseSuccess<T> | TCPResponseError;

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function handleTCPRequest(payload: any): Promise<HandleTCPReturn> {
  const { type } = payload ?? {};

  try {
    if (!type || typeof type !== "string") {
      throw new AppError(
        "Error.MissingType",
        { message: "Missing or invalid request type", path: "type" },
        400,
      );
    }

    // Chuẩn hoá data đầu vào
    const data = isPlainObject(payload?.data) ? payload.data : undefined;

    // Log an toàn (không dump toàn bộ payload)
    console.log(`[TCP] Incoming: ${type}`, {
      hasData: Boolean(data),
      ts: new Date().toISOString(),
    });

    let responseData: any;
    let message = "";
    let statusCode = 200;

    switch (type) {
      case "CREATE_TRANSACTION": {
        if (!data) {
          throw new AppError(
            "Error.MissingData",
            { message: "Missing data for CREATE_TRANSACTION", path: "data" },
            400,
          );
        }
        const input: CreateTransactionDto = data as CreateTransactionDto;
        console.log("📥 [CREATE_TRANSACTION] Input:", input);
        console.log("📥 [CREATE_TRANSACTION]");
        responseData = await paymentService.createTransaction(input);
        message = "Transaction created successfully";
        break;
      }

      case "CREATE_TOPUP": {
        if (!data) {
          throw new AppError(
            "Error.MissingData",
            { message: "Missing data for CREATE_TOPUP", path: "data" },
            400,
          );
        }
        const input: WalletTopUpDto = data as WalletTopUpDto;
        console.log("📥 [CREATE_TOPUP]");
        responseData =
          await paymentService.createWalletTopUpUsingPaymentTransaction(input);
        message = "Wallet top-up initiated";
        break;
      }

      case "HANDLE_PAYOS_CALLBACK": {
        if (!data) {
          throw new AppError(
            "Error.MissingData",
            { message: "Missing data for HANDLE_PAYOS_CALLBACK", path: "data" },
            400,
          );
        }

        const { orderCode, status } = data as {
          orderCode?: unknown;
          status?: unknown;
        };

        const orderCodeStr = String(orderCode ?? "").trim();
        if (!orderCodeStr) {
          throw new AppError(
            "Error.InvalidCallbackPayload",
            {
              message: "orderCode must be a non-empty string",
              path: "data.orderCode",
            },
            400,
          );
        }

        let normalizedStatus: "PAID" | "CANCELLED";
        if (status === "PAID" || status === "CANCELLED") {
          normalizedStatus = status as "PAID" | "CANCELLED";
        } else if (status === "00") {
          normalizedStatus = "PAID";
        } else {
          normalizedStatus = "CANCELLED";
        }

        responseData = await paymentService.handlePayOSCallback({
          orderCode: orderCodeStr,
          status: normalizedStatus,
        });

        message =
          (responseData && responseData.message) || "PayOS callback processed";
        break;
      }

      case "CREATE_PROPOSAL_TRANSACTION": {
        if (!data) {
          throw new AppError(
            "Error.MissingData",
            {
              message: "Missing data for CREATE_PROPOSAL_TRANSACTION",
              path: "data",
            },
            400,
          );
        }
        const { bookingId, method, userId } = data;
        if (
          typeof bookingId !== "number" ||
          !Number.isFinite(bookingId) ||
          bookingId <= 0
        ) {
          throw new AppError(
            "Error.InvalidBookingId",
            {
              message: "bookingId must be a valid positive number",
              path: "data.bookingId",
            },
            422,
          );
        }
        if (
          typeof userId !== "number" ||
          !Number.isFinite(userId) ||
          userId <= 0
        ) {
          throw new AppError(
            "Error.InvalidUserId",
            {
              message: "userId must be a valid positive number",
              path: "data.userId",
            },
            422,
          );
        }
        console.log("📥 [CREATE_PROPOSAL_TRANSACTION] Input:", data);

        responseData = await paymentService.createProposalPayment({
          bookingId,
          method,
          userId,
        });

        message = "Proposal transaction created successfully";
        break;
      }

      case "GET_PAYMENT_STATUS": {
        if (!data) {
          throw new AppError(
            "Error.MissingData",
            { message: "Missing data for GET_PAYMENT_STATUS", path: "data" },
            400,
          );
        }
        const { orderCode } = data as { orderCode?: unknown };

        if (typeof orderCode !== "string" || !orderCode.trim()) {
          throw new AppError(
            "Error.InvalidOrderCode",
            {
              message: "orderCode is required (string)",
              path: "data.orderCode",
            },
            400,
          );
        }

        responseData = await paymentService.getPaymentStatus(orderCode);
        message = "Payment status retrieved";
        break;
      }


      default: {
        throw new AppError(
          "Error.UnknownRequestType",
          { message: `Unknown request type: ${type}`, path: "type" },
          400,
        );
      }
    }

    const result: TCPResponseSuccess<any> = {
      success: true,
      code: "SUCCESS",
      message,
      data: responseData,
      statusCode,
      timestamp: new Date().toISOString(),
    };
    console.log("✅ handleTCPRequest result (summary):", {
      success: result.success,
      code: result.code,
      message: result.message,
      statusCode: result.statusCode,
      ts: result.timestamp,
    });

    return result;
  } catch (err: any) {
    // Log lỗi gọn, không lộ dữ liệu nhạy cảm
    console.error("❌ handleTCPRequest ERROR:", {
      name: err?.name,
      code: err?.code,
      statusCode: err?.statusCode,
      message: err?.message,
      ts: new Date().toISOString(),
    });

    if (err instanceof AppError) {
      const serialized = typeof err.toJSON === "function" ? err.toJSON() : null;
      const errorStr = serialized?.error ?? err.code ?? "AppError";
      const details = serialized?.message ?? [{ message: err.message }];

      const result: TCPResponseError = {
        message: details,
        error: errorStr,
        statusCode: err.statusCode ?? 400,
      };
      return result;
    }

    const fallback: TCPResponseError = {
      message: [{ message: "Internal Server Error" }],
      error: "Internal Server Error",
      statusCode: 500,
    };
    return fallback;
  }
}
