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
  - Admins see all routers, hosts see only their own
- `GET /api/routers/:id` - Get router details (requires auth)
  - Admins can access any router, hosts only their own
- `POST /api/routers` - Create new router (Admin only)
  - Requires `hostId` in request body to assign router to a host
  - Validates that hostId exists and user has HOST role
- `PUT /api/routers/:id` - Update router (requires auth)
  - Admins can update any router, hosts only their own
- `DELETE /api/routers/:id` - Delete router (requires auth)
  - Admins can delete any router, hosts only their own
- `POST /api/routers/:id/command` - Send command to router (requires auth)
  - Admins can send commands to any router, hosts only their own
- `GET /api/routers/:id/stats` - Get router statistics (requires auth)
  - Admins can view stats for any router, hosts only their own

### Invoices (`/api/invoices`) - Earnings/Payments
- `GET /api/invoices` - List all invoices (requires auth)
  - Admins see all invoices, hosts see only their earnings
- `GET /api/invoices/:id` - Get invoice details (requires auth)
  - Admins can view any invoice, hosts only their own
- `POST /api/invoices/:id/pay` - Mark invoice as paid (Admin only)
  - Used when platform processes payment to host

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

### Create Router (Admin only)

```bash
curl -X POST http://localhost:8080/api/routers \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Router",
    "hostId": "host-user-id",
    "location": "Office",
    "nasipaddress": "192.168.1.1"
  }'
```

**Note**: 
- Only admins can create routers
- `hostId` is required - must be a user with HOST role
- Router will be assigned to the specified host

### Send Command to Router

```bash
curl -X POST http://localhost:8080/api/routers/<router-id>/command \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "reboot"
  }'
```

### Mark Invoice as Paid (Admin only)

```bash
curl -X POST http://localhost:8080/api/invoices/<invoice-id>/pay \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json"
```

**Note**: Only admins can mark invoices as paid when platform processes payment to hosts.

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

