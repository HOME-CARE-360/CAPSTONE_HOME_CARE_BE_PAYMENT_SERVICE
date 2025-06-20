import { create } from "axios";
import { sendTCPRequest } from "../tcp/client";

function logResponse(title: string, result: any, timestamp = new Date().toISOString()) {
    if (result?.statusCode && result.statusCode >= 400) {
        console.warn(`⚠️ [${timestamp}] ${title} Failed:`, {
            statusCode: result.statusCode,
            error: result.error,
            message: result.message,
        });
    } else {
        console.log(`✅ [${timestamp}] ${title} Success:`);
        console.dir(result.data ?? result, { depth: null });
    }
}

/**
 * Test: CREATE_TRANSACTION
 */
export async function testCreateTransaction() {
    const timestamp = new Date().toISOString();
    const payload = {
        type: "CREATE_TRANSACTION",
        data: {
            bookingId: 11,
            amount: 50000,
            method: "CREDIT_CARD",
            userId: 12,
        },
    };

    try {
        const result = await sendTCPRequest(payload);
        logResponse("CREATE_TRANSACTION", result, timestamp);
    } catch (error: any) {
        console.error(`❌ [${timestamp}] CREATE_TRANSACTION Error:`, error.message);
    }
}


(async () => {
    await testCreateTransaction();

})();
