const ResponseHandler = require('../../../shared/utils/response');
const service = require('../../../shared/services/saccoLedgerService');
module.exports = { preview: async (req, res) => ResponseHandler.success(res, await service.previewWorkbook(req.body.records, req.body.sourceFile), 'Workbook preview generated', 200), commit: async (req, res) => ResponseHandler.success(res, await service.commitWorkbook(req.body.records, req.body.sourceFile, req.user?.id), 'Workbook ledger imported safely', 201) };
