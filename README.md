# Payment service

Payments through **PayOS**: create a checkout link for a booking, receive the payment webhook, reconcile the booking's payment state.

## How it is built

An Express service with a small TCP handler layer (`src/tcp`, `src/handlers`)
that speaks the same message-pattern contract the NestJS gateway uses, so the
gateway can call it like any other service. Messages are validated with zod
(`src/schemas`), business rules live in `src/services`, data access in
`src/repositories` through Prisma on PostgreSQL.

API documentation is served at `/api-docs` (swagger-jsdoc + swagger-ui-express).

## Run

```bash
npm install          # runs `prisma generate` on postinstall
npm run dev
```

## Configuration

Read from the environment (names as used in the code; no values are committed):

- `DATABASE_URL`
- `PAYMENT_HOST`
- `PAYMENT_TCP_PORT`
- `PAYOS_API_KEY`
- `PAYOS_CHECKSUM_KEY`
- `PAYOS_CLIENT_ID`
- `SERVER_URL`
- `TCP_HOST`
- `TCP_PORT`


## Part of Home Care 360

FPT University capstone project (2024–2025), built by a team of four; backend
services by [@tientran1234](https://github.com/tientran1234). The platform
overview, architecture diagram and the list of every service live in
[CAPSTONE_HOME_CARE_BE_MICROSERVICES](https://github.com/HOME-CARE-360/CAPSTONE_HOME_CARE_BE_MICROSERVICES).
