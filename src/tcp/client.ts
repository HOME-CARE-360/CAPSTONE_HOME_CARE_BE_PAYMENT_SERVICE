import net from 'net';
import dotenv from 'dotenv';
import {
  TCPResponseSuccess,
  TCPResponseError,
} from '../interfaces/tcp-response.interface';

dotenv.config();

const TCP_PORT = parseInt(process.env.TCP_PORT || '4000', 10);
const TCP_HOST = process.env.TCP_HOST || 'localhost';

type TCPResponse<T = any> = TCPResponseSuccess<T> | TCPResponseError;

export function sendTCPRequest<T = any>(
  message: object,
  timeout = 5000
): Promise<TCPResponse<T>> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    const dataToSend = JSON.stringify(message) + '\n';
    let buffer = '';
    let isResolved = false;

    const resolveOnce = (response: TCPResponse<T>) => {
      if (!isResolved) {
        isResolved = true;
        resolve(response);
        client.end();
      }
    };

    // Kết nối tới TCP server
    client.connect(TCP_PORT, TCP_HOST, () => {
      client.write(dataToSend, 'utf-8');
    });

    client.setEncoding('utf-8');

    client.on('data', (chunk) => {
      buffer += chunk;

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!raw) continue;

        try {
          const parsed = JSON.parse(raw);

          if (parsed.success === true) {
            resolveOnce(parsed as TCPResponseSuccess<T>);
            return;
          }

          if (Array.isArray(parsed.message) && typeof parsed.error === 'string') {
            resolveOnce(parsed as TCPResponseError);
            return;
          }

          // Nếu format không đúng
          throw new Error('Unrecognized response format');
        } catch (err) {
          resolveOnce({
            message: [
              {
                message: 'Invalid JSON or unexpected format from TCP server',
              },
            ],
            error: 'Invalid Response',
            statusCode: 500,
          });
        }
      }
    });

    client.on('error', (err) => {
      resolveOnce({
        message: [
          {
            message: `TCP connection error: ${err.message}`,
          },
        ],
        error: 'TCP Connection Error',
        statusCode: 500,
      });
      client.destroy();
    });

    client.setTimeout(timeout, () => {
      resolveOnce({
        message: [
          {
            message: 'TCP request timed out',
          },
        ],
        error: 'TCP Timeout',
        statusCode: 408,
      });
      client.destroy();
    });
  });
}
