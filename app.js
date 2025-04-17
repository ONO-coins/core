async function init() {
    const loggerManager = require('./managers/log.manager');
    loggerManager.setInitialLevel();

    const state = require('./state');
    state.init();

    const database = require('./databases/postgres');
    await database.init();

    const peerService = require('./services/peer.service');
    await peerService.init();

    const http = require('./http-server');
    await http.init();

    const p2p = require('./p2p');
    p2p.init();

    const wallet = require('./wallet');
    await wallet.init();

    const transactionPoolService = require('./services/transaction-pool.service');
    await transactionPoolService.init();

    const blockService = require('./services/block.service');
    await blockService.init();

    const forger = require('./forger');
    await forger.start();
}

init();
