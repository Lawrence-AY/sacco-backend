const express = require('express');
const { protect } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const searchController = require('../controllers/searchController');

const router = express.Router();

router.get('/', protect, validate(schemas.search, 'query'), searchController.globalSearch);

module.exports = router;
