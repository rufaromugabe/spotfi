# End User Management System

A comprehensive, scalable user management system integrated with RADIUS for WiFi hotspot operations.

## Overview

This system provides complete lifecycle management for end users (WiFi customers) including:
- User registration and profile management
- Service plan creation and management
- Plan assignment with automatic RADIUS synchronization
- Quota tracking (data, bandwidth, time limits)
- Usage monitoring and reporting

## Database Schema

### EndUser
Represents WiFi end users (separate from admin/host users).

**Fields:**
- `username` - Unique RADIUS username
- `password` - Hashed password (also stored in radcheck)
- `email`, `phone`, `fullName` - Optional profile information
- `status` - ACTIVE, INACTIVE, SUSPENDED, EXPIRED

### Plan
Service plans define quotas, bandwidth limits, and time restrictions.

**Fields:**
- `name`, `description` - Plan identification
- `price`, `currency` - Pricing information
- `dataQuota` - Total data allowed (bytes, null = unlimited)
- `quotaType` - MONTHLY, DAILY, WEEKLY, ONE_TIME
- `maxUploadSpeed`, `maxDownloadSpeed` - Bandwidth limits (bytes/sec)
- `sessionTimeout`, `idleTimeout` - Time limits (seconds)
- `maxSessions` - Max concurrent sessions
- `validityDays` - Plan validity period
- `isDefault` - Default plan for new users

### UserPlan
Links users to plans with assignment details.

**Fields:**
- `userId`, `planId` - Relations
- `status` - PENDING, ACTIVE, EXPIRED, CANCELLED
- `assignedAt`, `activatedAt`, `expiresAt` - Timeline
- `dataQuota`, `dataUsed` - Usage tracking
- `autoRenew`, `renewalPlanId` - Auto-renewal settings

## API Endpoints

### Plans (`/api/plans`)

**POST `/api/plans`** - Create plan (Admin only)
```json
{
  "name": "Basic 10GB",
  "description": "10GB monthly data",
  "price": 29.99,
  "dataQuota": 10737418240,  // 10GB in bytes
  "quotaType": "MONTHLY",
  "maxUploadSpeed": 10485760,  // 10 Mbps
  "maxDownloadSpeed": 52428800,  // 50 Mbps
  "sessionTimeout": 7200,  // 2 hours
  "idleTimeout": 600,  // 10 minutes
  "maxSessions": 1,
  "validityDays": 30,
  "isDefault": false
}
```

**GET `/api/plans`** - List plans
- Query params: `status`, `page`, `limit`

**GET `/api/plans/:id`** - Get plan details

**PUT `/api/plans/:id`** - Update plan (Admin only)

**DELETE `/api/plans/:id`** - Delete plan (Admin only, if no active users)

### End Users (`/api/end-users`)

**POST `/api/end-users`** - Register end user
```json
{
  "username": "user123",
  "password": "securepass",
  "email": "user@example.com",
  "phone": "+1234567890",
  "fullName": "John Doe",
  "planId": "plan-id-here"  // Optional: assign plan immediately
}
```

**GET `/api/end-users`** - List users
- Query params: `status`, `search`, `page`, `limit`
- Returns: Users with active plan info

**GET `/api/end-users/:id`** - Get user profile
- Returns: User details, active plan, usage statistics, plan history

**PUT `/api/end-users/:id`** - Update user
- Can update: email, phone, fullName, notes, status, password

**DELETE `/api/end-users/:id`** - Delete user (Admin only)
- Removes from RADIUS automatically

### User Plans (`/api/end-users/:userId/plans`)

**POST `/api/end-users/:userId/plans`** - Assign plan to user
```json
{
  "planId": "plan-id",
  "dataQuota": 21474836480,  // Optional: override plan quota
  "expiresAt": "2024-12-31T23:59:59Z",  // Optional: custom expiry
  "autoRenew": true,
  "renewalPlanId": "plan-id",  // Optional: different plan for renewal
  "notes": "Promotional plan"
}
```

**GET `/api/end-users/:userId/plans`** - List user's plans
- Returns: All plan assignments (active and historical)

**POST `/api/user-plans/:id/cancel`** - Cancel user plan
- Sets status to CANCELLED
- Syncs to RADIUS (disables if no other active plan)

**POST `/api/user-plans/:id/extend`** - Extend plan expiry
```json
{
  "days": 30
}
```

## RADIUS Integration

The system automatically syncs user plans to RADIUS tables:

### radcheck (Authentication Checks)
- `User-Password` - User password
- `Auth-Type` - Set to "Reject" if user disabled
- `Simultaneous-Use` - Max concurrent sessions (valid FreeRADIUS attribute)

### radreply (Reply Attributes)
- `Session-Timeout` - Max session duration
- `Idle-Timeout` - Idle timeout
- `WISPr-Bandwidth-Max-Up` - Upload bandwidth limit
- `WISPr-Bandwidth-Max-Down` - Download bandwidth limit
- `ChilliSpot-Max-Input-Octets` - Alternative upload limit
- `ChilliSpot-Max-Output-Octets` - Alternative download limit
- `MikroTik-Total-Limit` - Data quota limit

### radquota (Quota Tracking)
- Tracks data usage per quota period
- Supports MONTHLY, DAILY, WEEKLY, ONE_TIME quotas
- Automatically calculates period start/end dates

## Usage Examples

### 1. Create a Plan
```bash
curl -X POST http://localhost:8080/api/plans \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Premium Unlimited",
    "dataQuota": null,
    "maxUploadSpeed": 104857600,
    "maxDownloadSpeed": 104857600,
    "quotaType": "MONTHLY",
    "validityDays": 30,
    "price": 49.99
  }'
```

### 2. Register User with Plan
```bash
curl -X POST http://localhost:8080/api/end-users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john_doe",
    "password": "secure123",
    "email": "john@example.com",
    "fullName": "John Doe",
    "planId": "plan-id-here"
  }'
```

### 3. Assign Plan to Existing User
```bash
curl -X POST http://localhost:8080/api/end-users/user-id/plans \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "planId": "plan-id",
    "autoRenew": true
  }'
```

### 4. Get User Profile with Usage
```bash
curl http://localhost:8080/api/end-users/user-id \
  -H "Authorization: Bearer $TOKEN"
```

## Features

### ✅ Automatic RADIUS Sync
- Plans automatically sync to RADIUS when assigned
- User status changes reflect in RADIUS immediately
- Quota limits enforced via RADIUS attributes

### ✅ Flexible Quota Types
- **MONTHLY**: Resets on 1st of each month
- **DAILY**: Resets daily at midnight
- **WEEKLY**: Resets weekly (Sunday)
- **ONE_TIME**: One-time quota that doesn't reset

### ✅ Bandwidth Control
- Upload/download speed limits
- Multiple attribute formats (WISPr, ChilliSpot, MikroTik)
- Enforced at router level via RADIUS

### ✅ Time Limits
- Session timeout (max session duration)
- Idle timeout (inactivity limit)
- Plan validity period
- Max concurrent sessions

### ✅ Usage Tracking
- Real-time data usage per user
- Active session count
- Historical plan assignments
- Quota consumption tracking

### ✅ Auto-Renewal
- Automatic plan renewal on expiry
- Can renew to same or different plan
- Configurable per user plan

## Scalability Considerations

1. **Indexes**: All foreign keys and search fields are indexed
2. **Pagination**: All list endpoints support pagination
3. **Caching**: Consider caching plan definitions for high-traffic scenarios
4. **Background Jobs**: Quota resets and plan expiry checks should run as background jobs
5. **RADIUS Performance**: Batch RADIUS updates for bulk operations

## Security

- Passwords are hashed using bcrypt
- Admin-only endpoints require ADMIN role
- User passwords stored in radcheck for RADIUS authentication
- All endpoints require authentication

## Next Steps

1. **Create Migration**: Run `npm run prisma:migrate` to create database tables
2. **Seed Default Plans**: Create initial plans via API or seed script
3. **Background Jobs**: Implement cron jobs for:
   - Quota period resets
   - Plan expiry checks
   - Usage aggregation
4. **Notifications**: Add email/SMS notifications for:
   - Plan expiry warnings
   - Quota usage alerts
   - Plan renewals

