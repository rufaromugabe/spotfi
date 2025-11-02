# SpotFi API Documentation

## Base URL

```
http://localhost:8080
```

## Swagger UI

Interactive API documentation is available at:
- **Swagger UI**: http://localhost:8080/docs
- **OpenAPI JSON**: http://localhost:8080/docs/json

## Authentication

Most endpoints require JWT authentication. Include the token in the `Authorization` header:

```
Authorization: Bearer <your-jwt-token>
```

To get a token:
1. Register: `POST /api/auth/register`
2. Login: `POST /api/auth/login`

## Endpoints Overview

### Authentication (`/api/auth`)
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/me` - Get current user (requires auth)

### Routers (`/api/routers`)
- `GET /api/routers` - List all routers (requires auth)
- `GET /api/routers/:id` - Get router details (requires auth)
- `POST /api/routers` - Create new router (requires auth)
- `PUT /api/routers/:id` - Update router (requires auth)
- `DELETE /api/routers/:id` - Delete router (requires auth)
- `POST /api/routers/:id/command` - Send command to router (requires auth)
- `GET /api/routers/:id/stats` - Get router statistics (requires auth)

### Invoices (`/api/invoices`)
- `GET /api/invoices` - List all invoices (requires auth)
- `GET /api/invoices/:id` - Get invoice details (requires auth)
- `POST /api/invoices/:id/pay` - Mark invoice as paid (requires auth)

### WebSocket
- `WS /ws?id=ROUTER_ID&token=ROUTER_TOKEN` - Router WebSocket connection

### Health
- `GET /health` - Health check endpoint

## Example Requests

### Register User

```bash
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "role": "HOST"
  }'
```

### Login

```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

### Create Router

```bash
curl -X POST http://localhost:8080/api/routers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Router",
    "location": "Office"
  }'
```

### Send Command to Router

```bash
curl -X POST http://localhost:8080/api/routers/<router-id>/command \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "reboot"
  }'
```

## Response Formats

### Success Response

```json
{
  "data": { ... }
}
```

### Error Response

```json
{
  "error": "Error message"
}
```

## Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error
- `503` - Service Unavailable (router offline)

For complete API documentation with schemas, visit the Swagger UI at `/docs`.

