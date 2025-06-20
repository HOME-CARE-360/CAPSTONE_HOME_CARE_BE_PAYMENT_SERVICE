import { AppError } from './error';
import {
    TCPResponseError,
    TCPResponseSuccess,
} from '../interfaces/tcp-response.interface';
import {
    CreateTransactionDto,
    UpdateTransactionStatusDto,
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
                responseData = await paymentService.createTransaction(input);
                message = 'Transaction created successfully';
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
