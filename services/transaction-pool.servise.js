const transactionPoolDao = require('../databases/postgres/dao/transaction-pool.dao');

exports.init = async () => {
    await transactionPoolDao.clear();
};
