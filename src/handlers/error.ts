export interface AppErrorDetail {
  message: string;
  path?: string;
  [key: string]: any;
}

export class AppError extends Error {
  statusCode: number;
  details: AppErrorDetail[];
  code: string;

  constructor(
    code: string,
    details?: Partial<AppErrorDetail> | Partial<AppErrorDetail>[],
    statusCode = 400,
  ) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;

    const normalizedDetails = Array.isArray(details)
      ? details
      : [details || {}];
    this.details = normalizedDetails.map((detail) => ({
      message: code, // default message is the code
      ...detail,
    }));

    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON() {
    return {
      message: this.details,
      error: this._getErrorText(),
      statusCode: this.statusCode,
    };
  }

  private _getErrorText() {
    switch (this.statusCode) {
      case 400:
        return "Bad Request";
      case 401:
        return "Unauthorized";
      case 403:
        return "Forbidden";
      case 404:
        return "Not Found";
      case 422:
        return "Unprocessable Entity";
      case 500:
        return "Internal Server Error";
      default:
        return "Error";
    }
  }
}
