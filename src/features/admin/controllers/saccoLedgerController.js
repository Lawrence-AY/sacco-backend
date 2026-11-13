const ResponseHandler = require('../../../shared/utils/response');
const service = require('../../../shared/services/saccoLedgerService');
module.exports = {
  listImports: async (req, res) => ResponseHandler.success(
    res,
    await service.listWorkbookImports(),
    'Workbook imports retrieved successfully',
    200,
  ),
  getImport: async (req, res) => {
    const result = await service.getWorkbookImport(req.params.importId);
    if (!result) return ResponseHandler.notFound(res, 'Workbook import not found');
    return ResponseHandler.success(res, result, 'Workbook import retrieved successfully', 200);
  },
  applyImport: async (req, res) => ResponseHandler.success(
    res,
    await service.applyArchivedWorkbookImport(req.params.importId),
    'Archived workbook account data applied successfully',
    200,
  ),
  preview: async (req, res) => ResponseHandler.success(
    res,
    service.previewWorkbook(req.body.records, req.body.sourceFile),
    'Workbook preview generated',
    200,
  ),
  commit: async (req, res) => ResponseHandler.success(
    res,
    await service.commitWorkbook(req.body.records, req.body.sourceFile, req.user?.id, req.body.summaries),
    'Workbook rows saved and member account balances updated successfully',
    201,
  ),
};
