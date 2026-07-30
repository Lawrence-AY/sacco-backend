const asyncHandler = require('../../../shared/utils/asyncHandler');
const { success } = require('../../../shared/utils/response');
const searchService = require('../services/searchService');

const globalSearch = asyncHandler(async (req, res) => {
  const results = await searchService.searchAll(req.query, req.user);
  const { meta, ...groups } = results;

  return success(
    res,
    groups,
    'Search completed successfully',
    200,
    meta
  );
});

const memberByNumber = asyncHandler(async (req, res) => {
  const member = await searchService.findMemberByNumber(req.query.memberNumber);
  if (!member) {
    return success(res, null, 'No member found with that registration number', 200);
  }
  return success(res, member, 'Member found', 200);
});

module.exports = {
  globalSearch,
  memberByNumber,
};
