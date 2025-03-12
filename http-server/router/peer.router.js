const express = require('express');
const router = express.Router();
const peerController = require('../controllers/peer.controller');
const { errorCatcher } = require('../../managers/error.manager');

router.post('/', errorCatcher(peerController.addPeer));

module.exports = router;
