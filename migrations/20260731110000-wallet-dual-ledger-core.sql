CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
  CREATE TYPE wallet_status_enum AS ENUM ('ACTIVE', 'FROZEN', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE transaction_type_enum AS ENUM (
    'DEPOSIT', 'WITHDRAWAL', 'LOAN_DISBURSED', 'LOAN_REPAYMENT',
    'SHARE_PURCHASE', 'TRANSFER_INTERNAL', 'DIVIDEND_PAYOUT', 'MERCHANT_PAYMENT'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_method_enum AS ENUM ('MPESA_STK', 'MPESA_B2C', 'BANK_TRANSFER', 'CASH_DESK');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE transaction_status_enum AS ENUM ('PENDING', 'AI_ANALYZING', 'VERIFIED', 'REJECTED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE compliance_status_enum AS ENUM ('PASSED', 'FLAGGED', 'UNDER_REVIEW');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id VARCHAR(32) PRIMARY KEY,
  member_id VARCHAR(32) UNIQUE NOT NULL,
  deposited_balance DECIMAL(15,2) DEFAULT 0.00 NOT NULL CHECK (deposited_balance >= 0),
  withdrawable_balance DECIMAL(15,2) DEFAULT 0.00 NOT NULL CHECK (withdrawable_balance >= 0),
  status wallet_status_enum DEFAULT 'ACTIVE' NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  transaction_id VARCHAR(64) PRIMARY KEY,
  wallet_id VARCHAR(32) NOT NULL REFERENCES wallets(wallet_id) ON DELETE RESTRICT,
  member_id VARCHAR(32) NOT NULL,
  type transaction_type_enum NOT NULL,
  amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) DEFAULT 'KES' NOT NULL,
  prev_deposited_balance DECIMAL(15,2) NOT NULL,
  new_deposited_balance DECIMAL(15,2) NOT NULL,
  prev_withdrawable_balance DECIMAL(15,2) NOT NULL,
  new_withdrawable_balance DECIMAL(15,2) NOT NULL,
  payment_method payment_method_enum NOT NULL,
  external_reference VARCHAR(64),
  status transaction_status_enum DEFAULT 'PENDING' NOT NULL,
  device_id VARCHAR(128),
  ip_address VARCHAR(45),
  gps_location VARCHAR(64),
  operating_system VARCHAR(32),
  app_version VARCHAR(16),
  risk_score INT DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  aml_check_passed BOOLEAN DEFAULT TRUE,
  compliance_status compliance_status_enum DEFAULT 'PASSED',
  compliance_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blockchain_blocks (
  block_number BIGSERIAL PRIMARY KEY,
  transaction_id VARCHAR(64) UNIQUE NOT NULL REFERENCES wallet_transactions(transaction_id),
  transaction_hash VARCHAR(64) NOT NULL,
  previous_hash VARCHAR(64) NOT NULL,
  current_hash VARCHAR(64) NOT NULL,
  merkle_root VARCHAR(64) NOT NULL,
  digital_signature TEXT NOT NULL,
  validator_node_id VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_member ON wallet_transactions(member_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON wallet_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_blockchain_tx_id ON blockchain_blocks(transaction_id);
