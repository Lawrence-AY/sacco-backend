const ResponseHandler = require('../../../shared/utils/response');
const { getLedgerForUser } = require('../../../shared/services/saccoLedgerService');
module.exports = { getOwnLedger: async (req, res) => ResponseHandler.success(res, await getLedgerForUser(req.user.id), 'Member ledger retrieved', 200) };
