import { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'HomeCare 360 API',
            version: '1.0.0',
            description: 'Capstone HomeCare 360 Backend API Docs',
        },
        servers: [
            {
                url: process.env.SERVER_URL || 'http://localhost:3000',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
            schemas: {


                // --- User ---
                UserDto: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        name: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        phone: { type: 'string' },
                        avatar: { type: 'string', format: 'uri' },
                        status: {
                            type: 'string',
                            enum: ['ACTIVE', 'INACTIVE', 'BLOCKED'],
                        },
                        totpSecret: { type: 'string' },
                        createdAt: { type: 'string' },
                        updatedAt: { type: 'string' },
                        deletedAt: { type: 'string', nullable: true },
                    },
                },
                UpdateUserDto: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        phone: { type: 'string' },
                        avatar: { type: 'string', format: 'uri' },
                        status: {
                            type: 'string',
                            enum: ['ACTIVE', 'INACTIVE', 'BLOCKED'],
                        },
                        totpSecret: { type: 'string' },
                        deletedAt: { type: 'string', nullable: true },
                    },
                },
            },
        },
        security: [{ bearerAuth: [] }],
    },
    apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(options);

export const setupSwagger = (app: Express) => {
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
};
