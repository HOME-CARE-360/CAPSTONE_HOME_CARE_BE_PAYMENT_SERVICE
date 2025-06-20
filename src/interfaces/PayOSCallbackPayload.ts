export interface PayOSCallbackPayload {
    orderCode: string;
    amount: number;
    status: 'PAID' | 'FAILED';
    description?: string;
    [key: string]: any;
}