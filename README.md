# AG Shop Pro

A comprehensive auto shop management platform built for modern repair facilities. Manage repair orders, technicians, customers, inventory, and business operations all in one unified system.

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

#### 🏪 **Customer Portal**
- **Self-Service Access**: Customers can view service history and vehicle information
- **Appointment Scheduling**: Online booking system with availability management
- **Secure Authentication**: Dedicated customer login with session management
- **Profile Management**: Update contact information and communication preferences

### 🏗️ **Architecture Improvements**
- **Service Layer Architecture**: Modular services with dependency injection
- **Database Transactions**: ACID compliance for data integrity
- **Comprehensive API**: RESTful endpoints with proper error handling
- **Migration System**: Automated database schema updates

## 🏢 **User Roles & Testing Guide**

### 🔑 **Super Admin** (Platform Owners)
**Access**: All workspaces, users, billing, integrations
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

### 👔 **Manager** (Shop Owners/Managers)
**Access**: Full workspace control, financial reports, team management
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
- **Service Layer Pattern** for business logic
- **Transaction Management** for data consistency
- **JWT Authentication** with role-based permissions

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