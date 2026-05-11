const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const shareService = require('../services/shareService');

const getShares = asyncHandler(async (req, res) => {
  const shares = await shareService.getShareAccountsForUser(req.user);
  return ResponseHandler.success(res, shares, 'Shares retrieved successfully', 200);
});

module.exports = {
  getShares,
};
