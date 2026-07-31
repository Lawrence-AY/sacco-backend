const walletService = require('../services/walletService');
const asyncHandler = require('../../../shared/utils/asyncHandler');

const money = (value) => Number(Number(value || 0).toFixed(2));

const withdrawMpesa = asyncHandler(async (req, res) => {
  try {
    const result = await walletService.withdrawMpesa(req.body);

    if (result.rejected) {
      return res.status(403).json({
        status: 'REJECTED',
        transaction_id: result.rejected.transactionId,
        error: 'TRANSACTION_FLAGGED_BY_AI',
        ai_fraud_evaluation: {
          risk_score: result.risk.riskScore,
          aml_check: result.risk.amlCheckPassed ? 'PASSED' : 'FLAGGED',
          compliance_status: result.risk.complianceStatus,
          reason: result.risk.reason,
        },
      });
    }

    if (result.failed) {
      return res.status(502).json({
        status: 'FAILED',
        transaction_id: result.failed.transactionId,
        error: 'MPESA_B2C_PAYOUT_FAILED',
        ai_fraud_evaluation: {
          risk_score: result.risk.riskScore,
          aml_check: result.risk.amlCheckPassed ? 'PASSED' : 'FLAGGED',
          compliance_status: result.risk.complianceStatus,
        },
      });
    }

    return res.status(200).json({
      status: 'VERIFIED',
      transaction_id: result.verified.transactionId,
      amount: money(result.verified.amount),
      external_reference: result.verified.externalReference,
      balances: {
        previous_withdrawable: money(result.verified.prevWithdrawableBalance),
        new_withdrawable: money(result.verified.newWithdrawableBalance),
      },
      ai_fraud_evaluation: {
        risk_score: result.risk.riskScore,
        aml_check: result.risk.amlCheckPassed ? 'PASSED' : 'FLAGGED',
        compliance_status: result.risk.complianceStatus,
      },
      blockchain_audit: {
        block_number: Number(result.block.blockNumber),
        transaction_hash: result.block.transactionHash,
        block_hash: result.block.currentHash,
        validator_node: result.block.validatorNodeId,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      status: 'FAILED',
      error: error.message,
    });
  }
});

const getSummary = asyncHandler(async (req, res) => {
  try {
    const { wallet, latestBlock, integrityVerified } = await walletService.getSummary(req.params.wallet_id);
    const deposited = money(wallet.depositedBalance);
    const withdrawable = money(wallet.withdrawableBalance);

    return res.status(200).json({
      wallet_id: wallet.walletId,
      member_id: wallet.memberId,
      status: wallet.status,
      balances: {
        deposited_balance: deposited,
        withdrawable_balance: withdrawable,
        total_balance: money(deposited + withdrawable),
        currency: 'KES',
      },
      audit_status: {
        ledger_synchronized: Boolean(latestBlock),
        last_block_number: latestBlock ? Number(latestBlock.blockNumber) : null,
        integrity_verified: integrityVerified,
      },
      updated_at: new Date(wallet.updatedAt || wallet.createdAt || Date.now()).toISOString(),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      status: 'FAILED',
      error: error.message,
    });
  }
});

module.exports = {
  withdrawMpesa,
  getSummary,
};
