const express = require('express');
const router = express.Router();
const blockController = require('../controllers/block.controller');

router.get('/chain', blockController.getChain);
router.get('/:id', blockController.getOne);

module.exports = router;
