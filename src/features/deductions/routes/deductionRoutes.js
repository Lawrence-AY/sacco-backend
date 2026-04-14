const express = require('express');
const router = express.Router();
const deductionController = require('../controllers/deductionController');

router.post('/', deductionController.createDeduction);
router.get('/', deductionController.getDeductions);
router.patch('/:id', deductionController.updateDeduction);
router.post('/run', deductionController.runDeductions);

module.exports = router;
