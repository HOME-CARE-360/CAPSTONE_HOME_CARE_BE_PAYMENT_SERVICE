export interface TCPResponseSuccess<T = any> {
  success: boolean;
  code: string;
  message: string;
  timestamp: string;
  statusCode: number;
  data: T;
}
export interface TCPResponseError {
  message: {
    message: string;
    path?: string;
    [key: string]: any;
  }[];
  error: string;
  statusCode: number;
}
