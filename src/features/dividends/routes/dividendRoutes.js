const express = require('express');
const router = express.Router();

// Import controllers
const dividendController = require('../controllers/dividendController');

// Routes
router.get('/', dividendController.getAllDividends);
router.get('/:id', dividendController.getDividendById);
router.post('/', dividendController.createDividend);
router.put('/:id', dividendController.updateDividend);
router.delete('/:id', dividendController.deleteDividend);

module.exports = router;