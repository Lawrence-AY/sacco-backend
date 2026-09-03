const express = require('express');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const supportController = require('../controllers/supportController');

const router = express.Router();

router.post('/inquiries', validate(schemas.supportInquiry), supportController.submitInquiry);

module.exports = router;
