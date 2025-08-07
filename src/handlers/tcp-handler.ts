// FIX: Corrected import path for AppError
import { AppError } from '../handlers/error';
import {
    TCPResponseError,
    TCPResponseSuccess,
} from '../interfaces/tcp-response.interface';
import {
    CreateTransactionDto,
    // UpdateTransactionStatusDto, // Not used in this handler
    WalletTopUpDto,
} from '../schemas/type';
import * as paymentService from '../services/payment.service';

type HandleTCPReturn<T = any> = TCPResponseSuccess<T> | TCPResponseError;

export async function handleTCPRequest(payload: any): Promise<HandleTCPReturn> {
  const { type, data } = payload;

  try {
    if (!type || typeof type !== 'string') {
      throw new AppError('Error.MissingType', {
        message: 'Missing or invalid request type',
        path: 'type',
      }, 400);
    }

    let responseData: any;
    let message = '';
    let statusCode = 200;

    switch (type) {
      case 'CREATE_TRANSACTION': {
        const input: CreateTransactionDto = data;
        console.log("📥 [CREATE_TRANSACTION] Payload:", input);
        responseData = await paymentService.createTransaction(input);
        message = 'Transaction created successfully';
        break;
      }

      case 'CREATE_TOPUP': {
        const input: WalletTopUpDto = data;
        responseData = await paymentService.createWalletTopUpUsingPaymentTransaction(input);
        message = 'Wallet top-up initiated';
        break;
      }

      case 'HANDLE_PAYOS_CALLBACK': {
        const { orderCode, status } = data;
        // Basic validation for callback payload
        if (typeof orderCode !== 'string' || !['PAID', 'FAILED'].includes(status)) {
          throw new AppError('Error.InvalidCallbackPayload', {
            message: 'Invalid payload for PayOS callback. Expected { orderCode: string, status: "PAID" | "FAILED" }',
            path: 'data',
          }, 400);
        }
        responseData = await paymentService.handlePayOSCallback({ orderCode, status });
        message = responseData.message || 'PayOS callback processed';
        break;
      }

      case 'CREATE_PROPOSAL_TRANSACTION': {
        const { bookingId, method, userId } = data;

        // Validate required fields for proposal transaction
        if (!bookingId || typeof bookingId !== 'number') {
          throw new AppError('Error.InvalidBookingId', {
            message: 'bookingId must be a valid number',
            path: 'bookingId',
          }, 422);
        }

        if (!userId || typeof userId !== 'number') {
          throw new AppError('Error.InvalidUserId', {
            message: 'userId must be a valid number',
            path: 'userId',
          }, 422);
        }

        responseData = await paymentService.createProposalPayment({ bookingId, method, userId });
        message = 'Proposal transaction created successfully';
        break;
      }

      default:
        throw new AppError('Error.UnknownRequestType', {
          message: `Unknown request type: ${type}`,
          path: 'type',
        }, 400);
    }

    const result: TCPResponseSuccess<any> = {
      success: true,
      code: 'SUCCESS',
      message,
      data: responseData,
      statusCode,
      timestamp: new Date().toISOString(),
    };
    console.log('✅ handleTCPRequest result:', result);

    return result;

  } catch (err: any) {
    console.error('❌ handleTCPRequest ERROR:', err);

    if (err instanceof AppError) {
      const result: TCPResponseError = {
        message: err.details,
        error: err.toJSON().error,
        statusCode: err.statusCode,
      };
      return result;
    }

    const fallback: TCPResponseError = {
      message: [{ message: 'Internal Server Error' }],
      error: 'Internal Server Error',
      statusCode: 500,
    };
    return fallback;
  }
}
