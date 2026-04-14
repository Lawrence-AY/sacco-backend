# Ayedos Backend

A Node.js backend application built with Express and Prisma, now modeled for a SACCO core system.

## Architecture

This project uses a feature-based modular architecture where each feature is self-contained with:

- **Controllers**: Handle HTTP requests and responses
- **Services**: Implement domain logic
- **Routes**: Expose feature-specific API endpoints

### Core SACCO features

- **User / Member management**: Users, member profiles, verification
- **Membership applications**: Application, fee tracking, approval workflow
- **Savings account**: Member savings balances
- **Share account**: Share ownership tracking
- **Transactions**: Deposits, withdrawals, dividends, loan disbursements, repayments, membership fees
- **Loans**: Loan products, approval stages, guarantors
- **Salary deductions**: Recurring monthly deduction authorizations
- **Dividends**: Dividend distribution records
- **System configuration**: Share capital and monthly savings rules

## Models

The Prisma schema now includes:

- `User`
- `Member`
- `SavingsAccount`
- `ShareAccount`
- `Transaction`
- `Loan`
- `Guarantor`
- `Dividend`
- `MembershipApplication`
- `SalaryDeduction`
- `SystemConfig`

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up your database and update `.env` with the correct `DATABASE_URL`.

3. Run Prisma migrations:
   ```bash
   npx prisma migrate dev --name init
   ```

4. Generate Prisma client:
   ```bash
   npx prisma generate
   ```

5. Start the development server:
   ```bash
   npm run dev
   ```

## API Endpoints

- `/api/roles` - Role management
- `/api/transactions` - Transaction management
- `/api/dividends` - Dividend management
- `/api/flows` - Workflow management
- `/api/applications` - Membership application lifecycle
- `/api/deductions` - Salary deduction authorizations and monthly run
- `/api/loans` - Loan lifecycle and approval actions
- `/health` - Health check

## Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
