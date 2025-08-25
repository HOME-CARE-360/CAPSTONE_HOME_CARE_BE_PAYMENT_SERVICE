// services/config.service.ts
import { PrismaClient } from "../generated/prisma";
import { AppError } from "../handlers/error";

const prisma = new PrismaClient();
const configCache: Map<string, any> = new Map();

/**
 * Tải và lưu cache tất cả các cấu hình từ DB.
 * Nên gọi hàm này khi ứng dụng khởi động.
 */
export async function loadConfigFromDb() {
  console.log("Loading system configuration from database...");
  const configs = await prisma.systemConfig.findMany();
  configCache.clear();
  configs.forEach((c) => {
    let value;
    if (c.type === "number") {
      value = parseFloat(c.value || "0");
    } else if (c.type === "boolean") {
      value = c.value === "true";
    } else {
      value = c.value;
    }
    configCache.set(c.key, value);
  });
  console.log("System configuration loaded successfully.");
}

/**
 * Lấy một giá trị cấu hình từ cache.
 * @param key Khóa của cấu hình.
 * @param defaultValue Giá trị mặc định nếu không tìm thấy.
 * @returns Giá trị cấu hình đã được chuyển đổi kiểu dữ liệu.
 */
export function getConfig<T>(key: string, defaultValue?: T): T {
  if (configCache.has(key)) {
    return configCache.get(key) as T;
  }
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw new AppError("Error.ConfigNotFound", { message: `Configuration key '${key}' not found.` }, 500);
}


export async function updateConfig(key: string, value: string, type: string = 'string') {
  await prisma.systemConfig.upsert({
    where: { key },
    update: { value, type },
    create: { key, value, type },
  });
  await loadConfigFromDb();
}