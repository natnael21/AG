# AG Shop Pro

A comprehensive auto shop management platform built for modern repair facilities. Manage repair orders, technicians, customers, inventory, and business operations all in one unified system.

## Quick start (local)

Requires Node 24 and a PostgreSQL you can create databases on.

```bash
cd api
npm ci
cp .env.example .env          # then set DB_* (use DB_SSL=0 for a local postgres)
npm run migrate:latest        # create the schema
npm run dev                   # API + frontend on http://localhost:3000
```

`npm run dev` serves `public/` as well as the API, so the whole app runs on one
port with no second server:

| URL | Who it's for |
|---|---|
| `http://localhost:3000/login.html` | Shop staff (admin, manager, advisor, technician) |
| `http://localhost:3000/portal-login.html` | Customers |
| `http://localhost:3000/api/health` | Health check (database + SMTP) |

There are no seeded accounts and no demo login: every account is created through
the real signup/approval flow or by an admin invite. To create the first
super_admin on an empty database, insert one directly with a bcrypt hash, then
sign in at `/login.html`:

```bash
node -e "require('bcrypt').hash('YourPassword123!',12).then(h=>console.log(h))"
# INSERT INTO workspaces (name, active) VALUES ('My Shop', true);
# INSERT INTO users (name, email, password_hash, role, workspace_ids, active)
#   VALUES ('Owner','owner@example.com','<hash>','super_admin','{1}',true);
```

A customer can only sign in to the portal once a manager enables portal access
for them (`POST /api/admin/customers/:id/enable-portal`), which returns a
temporary password to hand over.

### Validation

```bash
npm run lint              # parses every file; blocks raw error leaks + client-side passwords
npm run test:unit         # no database needed
npm run test:integration  # real app against a real postgres — see api/test/README.md
```

## 🚀 Latest Updates (v2.0)

### ✨ New Features Added

#### 🛠️ **Enhanced Repair Order Management**
- **Complete RO Lifecycle**: Create, update, and track repair orders from intake to completion
- **Parts & Labor Tracking**: Add parts with inventory integration and labor with technician assignment
- **Time Clock Integration**: Technicians can clock in/out with automatic time tracking
- **Status Workflow**: Automated progression through repair stages with validation

#### 📦 **Parts & Inventory Management**
- **Parts Catalog**: Comprehensive parts database with categories, pricing, and suppliers
- **Stock Management**: Real-time inventory tracking with low stock alerts
- **Bulk Operations**: Import parts data and adjust inventory levels
- **Search & Filtering**: Advanced search across part numbers, names, and categories

#### 👥 **Advanced User Management**
- **Role-Based Access**: Super Admin, Manager, Service Advisor, Technician roles
- **User Invitations**: Email-based onboarding with automatic workspace assignment
- **Profile Management**: Self-service password changes and profile updates
- **Workspace Control**: Add/remove users from workspaces with proper permissions

#### 📊 **Business Intelligence & Reporting**
- **Financial Analytics**: Revenue trends, profitability analysis, and cost tracking
- **Technician Performance**: Productivity metrics, labor efficiency, and utilization rates
- **Customer Insights**: Service history analysis and customer lifetime value
- **Parts Analytics**: Usage patterns, stock optimization, and supplier performance

#### 🏪 **Customer Portal** (`portal-login.html` → `portal.html`)
- **Self-Service Access**: Customers can view service history and vehicle information
- **Appointment Scheduling**: Request and cancel appointments against their own vehicles
- **Feedback**: Rate a completed repair order, once
- **Secure Authentication**: Dedicated customer login, scoped to one shop, with its own session store
- **Profile Management**: Update contact information and change password

### 🏗️ **Architecture Improvements**
- **Service Layer Architecture**: Modular services with dependency injection
- **Database Transactions**: ACID compliance for data integrity
- **Comprehensive API**: RESTful endpoints with proper error handling
- **Migration System**: Automated database schema updates

## 🏢 **User Roles & Testing Guide**

> **Roles are the tenant boundary.** `super_admin` is AG platform staff only: it
> is the one role that can reach every workspace, review the signup queue, and
> see the full user directory. A shop that signs up is provisioned as a
> **`manager`** of its own workspace — full control of that shop and nothing
> outside it. Never grant `super_admin` to a shop; it removes their workspace
> boundary entirely. (Migration `008_signup_owner_role.sql` corrects owners that
> an earlier version of the signup flow provisioned as `super_admin`.)

### 🔑 **Super Admin** (AG platform staff only — created directly, never by signup)
**Access**: All workspaces, users, integrations
**Testing Focus**:
```bash
# Test user management
POST /api/users/invite
PATCH /api/users/:id/role
DELETE /api/users/:id/workspace

# Test reporting across workspaces
GET /api/reports/financial-summary
GET /api/reports/technician-performance
GET /api/reports/shop-kpis
```

### 👔 **Manager** (Shop Owners/Managers — what an approved signup becomes)
**Access**: Full control of their own workspace — repair orders, parts, team, customer portal provisioning, CSV import and financial reports — and nothing outside it
**Testing Focus**:
```bash
# Test repair order management
GET /api/repair-orders
POST /api/repair-orders
PATCH /api/repair-orders/:id

# Test parts management
GET /api/parts
POST /api/parts
POST /api/parts/:id/adjust-inventory

# Test reporting
GET /api/reports/financial-summary
GET /api/reports/customer-analytics
GET /api/reports/parts-analytics
```

### 🎯 **Service Advisor** (Front Desk)
**Access**: RO creation, customer management, appointment scheduling
**Testing Focus**:
```bash
# Test customer and vehicle management
GET /api/customers
POST /api/customers
GET /api/vehicles
POST /api/vehicles

# Test repair order workflow
POST /api/repair-orders
POST /api/repair-orders/:id/parts
POST /api/repair-orders/:id/labor
PATCH /api/repair-orders/:id/status
```

### 🔧 **Technician** (Bay Staff)
**Access**: Assigned ROs, time tracking, labor updates
**Testing Focus**:
```bash
# Test time clock functionality
POST /api/repair-orders/:id/time/clock-in
POST /api/repair-orders/:id/time/clock-out

# Test RO updates (assigned only)
GET /api/repair-orders/:id
PATCH /api/repair-orders/:id
```

### 👤 **Customer** (Portal Users)
**Access**: Service history, appointment booking, profile management
**Testing Focus**:
```bash
# Test customer authentication
POST /api/customer/login
POST /api/customer/logout

# Test service history access
GET /api/customer/service-history
GET /api/customer/vehicles

# Test appointment management
POST /api/customer/appointments
GET /api/customer/appointments
PATCH /api/customer/appointments/:id
DELETE /api/customer/appointments/:id

# Test profile management
GET /api/customer/profile
PATCH /api/customer/profile
PATCH /api/customer/change-password
```

## 🛠️ **Technical Architecture**

### Backend Services
- **Node.js/Express API** with PostgreSQL
- **Service Layer Pattern** for business logic — routes stay thin; workspace scoping, validation and transactions live in `api/services/`
- **Transaction Management** for data consistency
- **Opaque session tokens** (32 random bytes, stored in `sessions`/`customer_sessions` and checked against the database on every request) with role-based permissions. Staff and customer-portal sessions are separate and are not interchangeable.

### Database Schema
- **Multi-tenant Architecture** with workspace isolation
- **Comprehensive Audit Trail** for all operations
- **Optimized Indexes** for performance
- **Foreign Key Constraints** for data integrity

### API Design
- **RESTful Endpoints** with consistent naming
- **JSON Request/Response** format
- **HTTP Status Codes** for proper error handling
- **Pagination Support** for large datasets

## 🚀 **Deployment**

### Environment Setup
```bash
# Environment variables required
DB_HOST=your-rds-host
DB_NAME=your-database
DB_USER=your-username
DB_PASS=your-password
SMTP_HOST=your-smtp-host
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
```

### Database Migrations
```bash
# Run migrations (handled automatically in production)
npm run migrate:latest
```

### Production Deployment
- **AWS EC2** with PM2 process management
- **GitHub Actions CI/CD** for automated deployment
- **Nginx Reverse Proxy** for load balancing
- **SSL/TLS** encryption for all communications

## 📋 **Development Roadmap**

### Phase 1 ✅ (Completed)
- [x] Enhanced repair order management
- [x] Parts and inventory system
- [x] User management with roles
- [x] Business intelligence reporting
- [x] Customer portal

### Phase 2 🔄 (Next)
- [ ] Mobile app for technicians
- [ ] Advanced integrations (QuickBooks, Zapier)
- [ ] AI-powered diagnostics
- [ ] Automated scheduling
- [ ] Customer mobile app

## 📞 **Support**

- **Documentation**: [docs.html](public/docs.html)
- **API Reference**: Inline code documentation
- **Support Email**: support@agshopro.com
- **Issue Tracking**: GitHub Issues

---

**AG Shop Pro** - Modern auto shop management for the digital age. 