import { sendTCPRequest } from "../tcp/client";

/**
 * Logs the response from a TCP request, formatting it for readability.
 * @param title The title of the test case.
 * @param result The result object from the TCP request.
 * @param timestamp The timestamp of the request.
 */
function logResponse(
  title: string,
  result: any,
  timestamp = new Date().toISOString(),
) {
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
 * Creates a new booking payment transaction.
 */
export async function testCreateTransaction() {
  const timestamp = new Date().toISOString();
  const payload = {
    type: "CREATE_TRANSACTION",
    data: {
      serviceRequestId: 8,
      amount: 100000,
      userId: 21,
      method: "BANK_TRANSFER",
    },
  };
  console.log(
    `📦 Sending CREATE_TRANSACTION request at ${timestamp}:`,
    payload,
  );
  try {
    const result = await sendTCPRequest(payload);
    logResponse("CREATE_TRANSACTION", result, timestamp);
  } catch (error: any) {
    console.error(
      `❌ [${timestamp}] CREATE_TRANSACTION Error:`,
      error?.message || error,
    );
  }
}

/**
 * Test: CREATE_TOPUP
 * Initiates a wallet top-up transaction.
 */
export async function testCreateTopUp() {
  const timestamp = new Date().toISOString();
  const payload = {
    type: "CREATE_TOPUP",
    data: {
      amount: 2000,
      userId: 2,
      clientType: "native",
    },
  };

  try {
    const result = await sendTCPRequest(payload);
    logResponse("CREATE_TOPUP", result, timestamp);
  } catch (error: any) {
    console.error(
      `❌ [${timestamp}] CREATE_TOPUP Error:`,
      error?.message || error,
    );
  }
}

export async function testHandlePayOSCallback() {
  const timestamp = new Date().toISOString();

  const payload = {
    type: "HANDLE_PAYOS_CALLBACK",
    data: {
      orderCode: "1754846680166",
      status: "PAID",
    },
  };

  console.log(`📦 Sending HANDLE_PAYOS_CALLBACK at ${timestamp}:`, payload);

  try {
    const result = await sendTCPRequest(payload);
    logResponse("HANDLE_PAYOS_CALLBACK", result, timestamp);
  } catch (error: any) {
    console.error(
      `❌ [${timestamp}] HANDLE_PAYOS_CALLBACK Error:`,
      error?.message || error,
    );
  }
}

// ✅ Run test cases
(async () => {
  await testCreateTransaction();
  // await testCreateTopUp();
  // await testHandlePayOSCallback();
})();
