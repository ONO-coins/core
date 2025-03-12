const express = require('express');
const router = express.Router();
const secureController = require('../controllers/secure.controller');

router.get('/remove-chain-to/:blockId', secureController.removeChainTo);

module.exports = router;
