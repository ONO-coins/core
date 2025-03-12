const express = require('express');
const router = express.Router();
const balanceController = require('../controllers/balace.controller');

router.get('/:address', balanceController.getBalance);

module.exports = router;
