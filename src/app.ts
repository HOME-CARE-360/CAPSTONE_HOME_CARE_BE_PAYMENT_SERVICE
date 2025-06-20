import net from 'net';
import dotenv from 'dotenv';
import { handleTCPRequest } from './handlers/tcp-handler';

dotenv.config();
console.log(process.env.APP_NAME);


const TCP_PORT = parseInt(process.env.USER_TCP_PORT || '4001');
console.log(TCP_PORT);

const TCP_HOST = '0.0.0.0';

const server = net.createServer((socket) => {
    console.log('🔌 New TCP connection established');

    socket.on('data', async (data) => {
        try {
            const payload = JSON.parse(data.toString());
            const result = await handleTCPRequest(payload);
            socket.write(JSON.stringify(result) + '\n');
        } catch (err) {
            socket.write(
                JSON.stringify({
                    message: [{ message: 'Invalid JSON or server error' }],
                    error: 'Invalid Request',
                    statusCode: 400,
                }) + '\n'
            );
        }
    });

    socket.on('error', (err) => {
        console.error('❌ TCP socket error:', err.message);
    });
});

server.listen(TCP_PORT, TCP_HOST, () => {
    console.log(`🚀 TCP Microservice listening on ${TCP_HOST}:${TCP_PORT}`);
});
