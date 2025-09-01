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
export async function getConfig<T>(key: string, defaultValue?: T): Promise<T> {
  try {
    // Call Prisma directly to get config by key
    const config = await prisma.systemConfig.findUnique({
      where: { key }
    });
    
    if (config && config.value !== null) {
      // Parse value based on type if needed
      let parsedValue: any = config.value;
      
      if (config.type) {
        switch (config.type) {
          case 'number':
            const numValue = Number(config.value);
            parsedValue = isNaN(numValue) ? config.value : numValue;
            break;
          case 'boolean':
            parsedValue = config.value === 'true';
            break;
          case 'json':
            try {
              parsedValue = JSON.parse(config.value);
            } catch {
              parsedValue = config.value;
            }
            break;
          case 'string':
          default:
            parsedValue = config.value;
        }
      }
      
      return parsedValue as T;
    }
    
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    
    throw new AppError(
      "Error.ConfigNotFound", 
      { message: `Configuration key '${key}' not found.` }, 
      500
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    
    throw new AppError(
      "Error.ConfigNotFound", 
      { message: `Configuration key '${key}' not found.` }, 
      500
    );
  }
}

export async function updateConfig(key: string, value: string, type: string = 'string') {
  await prisma.systemConfig.upsert({
    where: { key },
    update: { value, type },
    create: { key, value, type },
  });
  await loadConfigFromDb();
}