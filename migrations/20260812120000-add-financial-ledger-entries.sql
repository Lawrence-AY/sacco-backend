CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
  CREATE TYPE financial_ledger_account_enum AS ENUM ('CASH', 'LOAN_RECEIVABLE', 'INTEREST_INCOME');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE financial_ledger_side_enum AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS financial_ledger_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID NOT NULL,
  loan_id UUID,
  member_id UUID,
  account financial_ledger_account_enum NOT NULL,
  side financial_ledger_side_enum NOT NULL,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) DEFAULT 'KES' NOT NULL,
  memo VARCHAR(255),
  posted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_financial_ledger_transaction ON financial_ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_loan ON financial_ledger_entries(loan_id);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_member ON financial_ledger_entries(member_id);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_account ON financial_ledger_entries(account);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_posted ON financial_ledger_entries(posted_at);
