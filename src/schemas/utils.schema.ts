import { z } from 'zod';

// ================== Regex & Date ==================
export const vietnamPhoneRegex = /^(0|\+84)(3[2-9]|5[6|8|9]|7[0|6-9]|8[1-5]|9[0-9])[0-9]{7}$/;

export const zodDate = () =>
  z.preprocess(
    (arg) => {
      if (typeof arg === 'string' || arg instanceof Date) {
        const date = new Date(arg);
        return isNaN(date.getTime()) ? undefined : date;
      }
      return undefined;
    },
    z.date({
      required_error: 'REQUIRED_DATE',
      invalid_type_error: 'INVALID_DATE',
    })
  );
