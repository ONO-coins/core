const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transaction.controller');
const { errorCatcher } = require('../../managers/error.manager');

router.get('/by-hash/:hash', errorCatcher(transactionController.getByHash));
router.get('/by-address/:address', errorCatcher(transactionController.getByAddress));
router.get('/count-by-address/:address', errorCatcher(transactionController.countByAddress));
router.post('/init', errorCatcher(transactionController.init));

module.exports = router;
