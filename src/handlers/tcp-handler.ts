
import { AppError } from './error';
import {
    TCPResponseError,
    TCPResponseSuccess,
} from '../interfaces/tcp-response.interface';


type HandleTCPReturn<T = any> = TCPResponseSuccess<T> | TCPResponseError;

export async function handleTCPRequest(payload: any): Promise<HandleTCPReturn> {
    const { type, userId, data } = payload;

    try {
        if (!userId || typeof userId !== 'number') {
            throw new AppError('Error.InvalidUserId', {
                message: 'userId must be a valid number',
                path: 'userId',
            }, 400);
        }

        let responseData: any;
        let message = '';
        let statusCode = 200;

        switch (type) {

            default:
                throw new AppError('Error.UnknownRequestType', {
                    message: 'Unknown request type',
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
