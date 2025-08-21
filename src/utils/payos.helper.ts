import crypto from "crypto";

export const generateChecksum = (data: any, key: string) => {
  const sortedKeys = Object.keys(data).sort();
  const rawData = sortedKeys.map((k) => `${k}=${data[k]}`).join("&");
  return crypto.createHmac("sha256", key).update(rawData).digest("hex");
};
