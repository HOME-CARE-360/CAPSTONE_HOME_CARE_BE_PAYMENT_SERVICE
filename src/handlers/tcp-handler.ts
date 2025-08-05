import { AppError } from './error';
import {
    TCPResponseError,
    TCPResponseSuccess,
} from '../interfaces/tcp-response.interface';
import {
    CreateTransactionDto,
    UpdateTransactionStatusDto, // This DTO is not used in the provided code, but kept for completeness if it were.
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
                // Assuming TCP requests for transaction creation originate from a native app context
                // or an internal service that should behave like a native client for deep linking.
                // If clientType can be dynamic, it should be passed in the payload.
                responseData = await paymentService.createTransaction(input, 'native');
                message = 'Transaction created successfully';
                break;
            }

            case 'CREATE_TOPUP': {
                const input: WalletTopUpDto = data;
                // Assuming TCP requests for wallet top-up originate from a native app context.
                responseData = await paymentService.createWalletTopUpUsingPaymentTransaction(input, 'native');
                message = 'Wallet top-up initiated';
                break;
            }

            case 'HANDLE_PAYOS_CALLBACK': {
                // This case handles the scenario where an external system (e.g., API Gateway)
                // receives the PayOS HTTP webhook and then forwards it as a TCP request to this microservice.
                // The 'data' payload for this type should contain 'orderCode' and 'status'.
                const { orderCode, status } = data;

                if (typeof orderCode !== 'string' || !['PAID', 'FAILED'].includes(status)) {
                    throw new AppError('Error.InvalidCallbackPayload', {
                        message: 'Invalid payload for PayOS callback. Expected { orderCode: string, status: "PAID" | "FAILED" }',
                        path: 'data',
                    }, 400);
                }

                // Call the existing handlePayOSCallback function from the payment service
                responseData = await paymentService.handlePayOSCallback({ orderCode, status });
                message = responseData.message || 'PayOS callback processed'; // Use message from service response
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
        console.log(result);

        return result;

    } catch (err: any) {
        console.error('handleTCPRequest ERROR:', err);

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
