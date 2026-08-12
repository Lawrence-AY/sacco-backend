const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../../models');

const VALIDATOR_NODE_ID = process.env.WALLET_VALIDATOR_NODE_ID || 'Validator-Node-01';
const GENESIS_HASH = '0'.repeat(64);

const toMoney = (value) => Number(Number(value || 0).toFixed(2));

const makeTransactionId = () => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  return `TXN-${date}-${suffix}`;
};

const sha256 = (payload) => crypto
  .createHash('sha256')
  .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
  .digest('hex');

const signPayload = (payloadHash) => {
  const privateKey = process.env.WALLET_SIGNING_PRIVATE_KEY;
  if (privateKey) {
    return crypto.sign('sha256', Buffer.from(payloadHash), privateKey).toString('base64');
  }
  return crypto
    .createHmac('sha256', process.env.WALLET_SIGNING_SECRET || 'local-wallet-ledger-signing-secret')
    .update(payloadHash)
    .digest('base64');
};

const getMemberKycStatus = async (memberId) => {
  const member = await db.Member.findOne({
    where: {
      [Op.or]: [
        { id: memberId },
        { memberNumber: memberId },
      ],
    },
  });

  if (!member) return { found: false, verified: false };
  return { found: true, verified: Boolean(member.isVerified || member.status === 'ACTIVE') };
};

const assessRisk = async ({ memberId, walletId, amount, telemetry = {} }) => {
  let riskScore = 0;
  const reasons = [];
  const kyc = await getMemberKycStatus(memberId);

  if (!kyc.found) {
    riskScore += 35;
    reasons.push('Member record could not be verified for KYC.');
  } else if (!kyc.verified) {
    riskScore += 60;
    reasons.push('Member KYC verification is not active.');
  }

  if (!telemetry.device_id) {
    riskScore += 15;
    reasons.push('Missing device identifier.');
  }
  if (!telemetry.ip_address) {
    riskScore += 10;
    reasons.push('Missing client IP address.');
  }
  if (!telemetry.gps_location) {
    riskScore += 10;
    reasons.push('Missing GPS location.');
  }
  if (Number(amount) >= 100000) {
    riskScore += 35;
    reasons.push('High-value withdrawal requires enhanced review.');
  }

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentWithdrawals = await db.WalletTransaction.findAll({
    where: {
      walletId,
      memberId,
      type: 'WITHDRAWAL',
      createdAt: { [Op.gte]: fiveMinutesAgo },
    },
  });

  const recentHighValueCount = recentWithdrawals
    .filter((transaction) => Number(transaction.amount || 0) >= 10000)
    .length;
  if (recentHighValueCount >= 3) {
    riskScore += 45;
    reasons.push('Withdrawal velocity threshold exceeded.');
  }

  const lastTransaction = recentWithdrawals[0];
  if (lastTransaction?.deviceId && telemetry.device_id && lastTransaction.deviceId !== telemetry.device_id) {
    riskScore += 15;
    reasons.push('Device identifier changed during recent withdrawal activity.');
  }
  if (lastTransaction?.gpsLocation && telemetry.gps_location && lastTransaction.gpsLocation !== telemetry.gps_location) {
    riskScore += 15;
    reasons.push('Anomalous geographic velocity detected across device sessions.');
  }

  const amlCheckPassed = !reasons.some((reason) =>
    reason.includes('KYC') || reason.includes('High-value') || reason.includes('velocity'));

  riskScore = Math.min(100, riskScore);

  return {
    riskScore,
    amlCheckPassed,
    complianceStatus: riskScore < 50 ? 'PASSED' : 'FLAGGED',
    reason: reasons[0] || 'Risk assessment passed.',
  };
};

const executeMpesaB2C = async ({ transactionId }) => {
  const receipt = `SGH${sha256(transactionId).slice(0, 7).toUpperCase()}`;
  return { success: true, resultCode: 0, receipt };
};

const mintBlock = async (walletTransaction) => {
  const latestBlocks = await db.BlockchainBlock.findAll({
    order: [['blockNumber', 'DESC']],
    limit: 1,
  });
  const previousBlock = latestBlocks[0];
  const blockNumber = Number(previousBlock?.blockNumber || 10501) + 1;
  const previousHash = previousBlock?.currentHash || GENESIS_HASH;
  const transactionPayload = {
    transaction_id: walletTransaction.transactionId,
    wallet_id: walletTransaction.walletId,
    member_id: walletTransaction.memberId,
    type: walletTransaction.type,
    amount: toMoney(walletTransaction.amount),
    currency: walletTransaction.currency,
    status: walletTransaction.status,
    external_reference: walletTransaction.externalReference,
    created_at: walletTransaction.createdAt,
  };
  const transactionHash = sha256(transactionPayload);
  const merkleRoot = sha256([transactionHash]);
  const blockPayload = {
    block_number: blockNumber,
    previous_hash: previousHash,
    transaction_hash: transactionHash,
    merkle_root: merkleRoot,
    validator_node_id: VALIDATOR_NODE_ID,
  };
  const currentHash = sha256(blockPayload);

  return db.BlockchainBlock.create({
    id: `BLK-${blockNumber}`,
    blockNumber,
    transactionId: walletTransaction.transactionId,
    transactionHash,
    previousHash,
    currentHash,
    merkleRoot,
    digitalSignature: signPayload(transactionHash),
    validatorNodeId: VALIDATOR_NODE_ID,
  });
};

const withdrawMpesa = async ({ member_id, wallet_id, phone_number, amount, currency = 'KES', telemetry = {} }) => {
  if (!member_id || !wallet_id || !phone_number || !amount) {
    const error = new Error('member_id, wallet_id, phone_number, and amount are required');
    error.statusCode = 400;
    throw error;
  }

  const requestedAmount = toMoney(amount);
  if (requestedAmount <= 0) {
    const error = new Error('amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const transactionId = makeTransactionId();

  return db.sequelize.transaction(async (transaction) => {
    const wallet = await db.Wallet.findOne({
      where: { walletId: wallet_id, memberId: member_id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!wallet) {
      const error = new Error('Wallet not found');
      error.statusCode = 404;
      throw error;
    }
    if (wallet.status !== 'ACTIVE') {
      const error = new Error('Wallet is not active');
      error.statusCode = 423;
      throw error;
    }

    const prevDeposited = toMoney(wallet.depositedBalance);
    const prevWithdrawable = toMoney(wallet.withdrawableBalance);
    if (requestedAmount > prevWithdrawable) {
      const error = new Error('Insufficient withdrawable balance');
      error.statusCode = 400;
      throw error;
    }

    const risk = await assessRisk({
      memberId: member_id,
      walletId: wallet_id,
      amount: requestedAmount,
      telemetry,
    });

    if (risk.riskScore >= 50) {
      const rejected = await db.WalletTransaction.create({
        id: transactionId,
        transactionId,
        walletId: wallet_id,
        memberId: member_id,
        type: 'WITHDRAWAL',
        amount: requestedAmount,
        currency,
        prevDepositedBalance: prevDeposited,
        newDepositedBalance: prevDeposited,
        prevWithdrawableBalance: prevWithdrawable,
        newWithdrawableBalance: prevWithdrawable,
        paymentMethod: 'MPESA_B2C',
        status: 'REJECTED',
        deviceId: telemetry.device_id,
        ipAddress: telemetry.ip_address,
        gpsLocation: telemetry.gps_location,
        operatingSystem: telemetry.operating_system,
        appVersion: telemetry.app_version,
        riskScore: risk.riskScore,
        amlCheckPassed: risk.amlCheckPassed,
        complianceStatus: risk.complianceStatus,
        complianceReason: risk.reason,
      }, { transaction });

      return { rejected, risk };
    }

    const payout = await executeMpesaB2C({ transactionId, phoneNumber: phone_number, amount: requestedAmount });
    if (!payout.success) {
      const failed = await db.WalletTransaction.create({
        id: transactionId,
        transactionId,
        walletId: wallet_id,
        memberId: member_id,
        type: 'WITHDRAWAL',
        amount: requestedAmount,
        currency,
        prevDepositedBalance: prevDeposited,
        newDepositedBalance: prevDeposited,
        prevWithdrawableBalance: prevWithdrawable,
        newWithdrawableBalance: prevWithdrawable,
        paymentMethod: 'MPESA_B2C',
        status: 'FAILED',
        riskScore: risk.riskScore,
        amlCheckPassed: risk.amlCheckPassed,
        complianceStatus: risk.complianceStatus,
      }, { transaction });
      return { failed, risk };
    }

    const newWithdrawable = toMoney(prevWithdrawable - requestedAmount);
    await wallet.update({ withdrawableBalance: newWithdrawable }, { transaction });

    const verified = await db.WalletTransaction.create({
      id: transactionId,
      transactionId,
      walletId: wallet_id,
      memberId: member_id,
      type: 'WITHDRAWAL',
      amount: requestedAmount,
      currency,
      prevDepositedBalance: prevDeposited,
      newDepositedBalance: prevDeposited,
      prevWithdrawableBalance: prevWithdrawable,
      newWithdrawableBalance: newWithdrawable,
      paymentMethod: 'MPESA_B2C',
      externalReference: payout.receipt,
      status: 'VERIFIED',
      deviceId: telemetry.device_id,
      ipAddress: telemetry.ip_address,
      gpsLocation: telemetry.gps_location,
      operatingSystem: telemetry.operating_system,
      appVersion: telemetry.app_version,
      riskScore: risk.riskScore,
      amlCheckPassed: risk.amlCheckPassed,
      complianceStatus: risk.complianceStatus,
    }, { transaction });

    const member = await db.Member.findOne({
      where: {
        [Op.or]: [
          { id: member_id },
          { memberNumber: member_id },
        ],
      },
      transaction,
    });
    await db.Transaction.create({
      memberId: member?.id || null,
      type: 'WITHDRAWAL',
      amount: requestedAmount,
      method: 'MPESA',
      status: 'SUCCESS',
      reference: payout.receipt,
      description: `Wallet withdrawal ${transactionId}`,
      paymentCategory: 'wallet_withdrawal',
      internalReference: transactionId,
    }, { transaction });

    const block = await mintBlock(verified);
    return { verified, risk, block };
  });
};

const getSummary = async (walletId) => {
  const wallet = await db.Wallet.findOne({ where: { walletId } });
  if (!wallet) {
    const error = new Error('Wallet not found');
    error.statusCode = 404;
    throw error;
  }

  const blocks = await db.BlockchainBlock.findAll({ order: [['blockNumber', 'DESC']] });
  return {
    wallet,
    latestBlock: blocks[0] || null,
    integrityVerified: blocks.every((block, index) => {
      if (index === blocks.length - 1) return true;
      return block.previousHash === blocks[index + 1].currentHash;
    }),
  };
};

module.exports = {
  withdrawMpesa,
  getSummary,
};
