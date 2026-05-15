# Ayedos Backend - Railway Production Ready

A modern, secure Node.js backend for the Ayedos SACCO management system built with Express and Sequelize. Features enterprise-grade error handling, JWT authentication, and Railway-optimized deployment.

## 🚀 Railway Deployment

### Prerequisites
- Railway account
- PostgreSQL database (Railway provides this)
- SMTP service for email (optional but recommended)

### Environment Variables

Set these in your Railway project environment:

#### Required
```bash
DATABASE_URL=postgresql://user:password@host:port/database
JWT_SECRET=your-super-secure-jwt-secret-here
JWT_REFRESH_SECRET=your-refresh-token-secret-here
CORS_ORIGIN=https://your-frontend-domain.com
```

#### Optional (but recommended for full functionality)
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Railway automatically provides PORT
# NODE_ENV is automatically set to 'production'
```

### Deployment Steps

1. **Connect Repository**
   - Push this code to GitHub
   - Connect your Railway project to the repository

2. **Database Setup**
   - Railway automatically provisions PostgreSQL
   - The app will auto-sync the schema on first deploy

3. **Environment Configuration**
   - Add environment variables in Railway dashboard
   - Set `NODE_ENV=production` (automatic)

4. **Deploy**
   - Railway will build and deploy automatically
   - Monitor logs for any issues

### Health Checks

The app provides several health check endpoints:

- `GET /health` - Basic health check
- `GET /health/detailed` - Comprehensive health with DB connectivity
- `GET /health/railway` - Railway-specific health check

### Production Features

- **No Process Crashes**: Global error handlers prevent container termination
- **Async Startup**: Database connection verified before accepting requests
- **Railway Binding**: Automatic `0.0.0.0` binding for Railway
- **Production Logging**: Winston-based structured logging
- **Graceful Shutdown**: Proper SIGTERM/SIGINT handling
- **Rate Limiting**: API protection against abuse
- **Security Headers**: Helmet.js security middleware

### Monitoring

Check these endpoints for production monitoring:

```bash
# Health status
curl https://your-app.railway.app/health

# Detailed health with DB check
curl https://your-app.railway.app/health/detailed

# Railway health check
curl https://your-app.railway.app/health/railway
```

### Troubleshooting

**Container keeps restarting?**
- Check Railway logs for unhandled errors
- Verify DATABASE_URL is correct
- Ensure JWT_SECRET is set
- Check if database is accessible

**Login requests failing?**
- Email service failures no longer crash the app
- Check SMTP configuration if emails aren't sending
- Login process continues even if email fails

**Database connection issues?**
- Railway may take time to provision database
- Check `/health/detailed` endpoint for DB status
- Verify DATABASE_URL format (Railway uses postgres://)

## 🌟 Key Features

### Security
- **JWT Authentication**: Dual token system (access & refresh tokens)
- **Password Security**: Bcrypt hashing with configurable rounds
- **Role-Based Access Control**: ADMIN, FINANCE, and MEMBER roles
- **Protected Routes**: Automatic authentication and authorization checking

### API Quality
- **Standardized Responses**: Consistent JSON format across all endpoints
- **Comprehensive Error Handling**: Custom error classes with meaningful messages
- **Input Validation**: Email, UUID, phone, range, and schema validation
- **Request Logging**: Development-mode request tracking

### Developer Experience
- **Async Error Wrapper**: Automatic error handling in async routes
- **Middleware Stack**: Pre-configured authentication, CORS, and error handling
- **Response Handler**: Helper methods for success, error, and paginated responses
- **TypeScript-Ready**: Well-structured code for easy TypeScript migration

## 📋 Architecture

This project uses a **feature-based modular architecture** where each feature is self-contained:

```
features/
├── feature-name/
│   ├── controllers/      # HTTP request handlers
│   ├── routes/          # Express route definitions
│   └── services/        # Business logic
```

### Core SACCO Features

- **Users & Members**: User accounts, member profiles, verification
- **Membership Applications**: Application workflow, approval stages
- **Accounts**: Savings and share accounts with balances
- **Transactions**: Deposits, withdrawals, dividends, loan disbursements
- **Loans**: Loan products, approval workflow, guarantors
- **Salary Deductions**: Recurring monthly authorizations
- **Dividends**: Distribution records and tracking
- **System Config**: Configuration management

## 🗃️ Database Models

- User
- Member
- Role
- SavingsAccount
- ShareAccount
- Transaction
- Loan
- Guarantor
- Dividend
- MembershipApplication
- SalaryDeduction
- SystemConfig

## 🚀 Quick Start

### Prerequisites
- Node.js 14+ (16+ recommended)
- PostgreSQL 12+
- npm or yarn

### Installation

1. **Clone and install**:
   ```bash
   git clone <repository>
   cd ayedos-backend
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your database URL and JWT secret
   ```

3. **Start the server**:
   ```bash
   # Development (with auto-reload)
   npm run dev

   # Production
   npm start
   ```

4. **Verify it's running**:
   ```bash
   curl http://localhost:3000/health
   ```

## 📚 Documentation

- **[API Documentation](./API_DOCUMENTATION.md)** - Complete API reference
- **[JWT Implementation Guide](./JWT_IMPLEMENTATION.md)** - Authentication details
- **[.env Configuration](./.env.example)** - Environment variables template

## 🔐 Authentication

### Login Flow

```bash
# Register a new user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "password": "securepassword123",
    "role": "MEMBER"
  }'

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "securepassword123"
  }'
```

### Using Access Tokens

```bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  http://localhost:3000/api/loans
```

### Token Refresh

```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
```

## 🛣️ API Endpoints

### Authentication (Public)
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login and get tokens
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout user

### Resources (Protected)
| Resource | Endpoints | Protection |
|----------|-----------|-----------|
| Roles | GET, POST, PUT, DELETE `/api/roles` | Admin only |
| Loans | GET, POST, PUT, DELETE `/api/loans` | Authenticated, create/update protected |
| Transactions | GET, POST, PUT, DELETE `/api/transactions` | Authenticated |
| Dividends | GET, POST, PUT, DELETE `/api/dividends` | Finance/Admin only |
| Deductions | GET, POST, PUT `/api/deductions` | Finance/Admin only |
| Flows | GET, POST, PUT, DELETE `/api/flows` | Admin only |
| Applications | GET, POST, PUT `/api/applications` | Public (submit), Admin only (manage) |

### Health Check
- `GET /health` - Server status

## 📝 Scripts

```bash
npm start              # Production server
npm run dev           # Development with auto-reload
npm run build         # Build (placeholder)
npm test              # Run tests (placeholder)
```

## 🏗️ Project Structure

```
src/
├── app.js                      # Express app configuration
├── index.js                    # Server entry point
├── shared/
│   ├── config/
│   │   └── db.js              # Database connection
│   ├── middleware/
│   │   ├── authMiddleware.js  # JWT & role-based auth
│   │   └── errorMiddleware.js # Centralized error handling
│   └── utils/
│       ├── jwt.js             # JWT token utilities
│       ├── errors.js          # Custom error classes
│       ├── response.js        # Response handler
│       ├── validation.js      # Input validation
│       └── asyncHandler.js    # Async error wrapper
├── models/                     # Sequelize models
│   ├── user.model.js
│   ├── loan.model.js
│   └── ...
└── features/                   # Feature modules
    ├── loans/
    ├── transactions/
    ├── dividends/
    ├── applications/
    ├── deductions/
    ├── flows/
    └── roles/
```

## 🔧 Error Handling

All endpoints return standardized error responses:

```json
{
  "success": false,
  "message": "Error description",
  "errors": { "field": "error message" },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

Custom error types:
- `ValidationError` (400)
- `UnauthorizedError` (401)
- `ForbiddenError` (403)
- `NotFoundError` (404)
- `ConflictError` (409)
- `DatabaseError` (500)

## ✅ Best Practices

1. **Always use AsyncHandler** for async route handlers
2. **Throw custom errors** for consistent error handling
3. **Validate input** using validation utilities
4. **Protect routes** with authentication/authorization
5. **Use ResponseHandler** for all responses
6. **Document endpoints** with JSDoc comments

## 🐛 Troubleshooting

### Connection Issues
- Verify DATABASE_URL in .env
- Check PostgreSQL is running
- Review database credentials

### Authentication Issues
- Ensure JWT_SECRET is set in .env
- Check token format: `Authorization: Bearer <token>`
- Verify token hasn't expired

### Authorization Issues
- Check user role matches route requirements
- Admin routes require ADMIN role
- Finance routes require ADMIN or FINANCE role

## 📦 Dependencies

- **Express** 5.2.1 - Web framework
- **Sequelize** 6.37.8 - ORM
- **PostgreSQL** - Database
- **jsonwebtoken** 9.0.3 - JWT handling
- **bcrypt** 6.0.0 - Password hashing
- **dotenv** 17.4.2 - Environment configuration
- **CORS** 2.8.5 - Cross-origin requests
- **nodemon** 3.1.14 (dev) - Auto-reload

## 🤝 Contributing

1. Follow the existing code structure
2. Use feature-based modules
3. Write JSDoc comments
4. Use meaningful commit messages
5. Test endpoints before submitting

## 📄 License

[Add your license here]

## 📞 Support

For issues or questions, please create an issue in the repository or contact the development team.

---

**Last Updated**: January 2024
**Version**: 2.0.0 (Enhanced)
