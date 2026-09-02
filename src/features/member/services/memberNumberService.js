const db = require('../../../models');

const PREFIX = '29903';

async function createMember(data) {
  return db.sequelize.transaction(async (transaction) => {
    // Serialize number allocation across all onboarding paths. PostgreSQL holds
    // this transaction-scoped lock until the member row is committed.
    if (db.sequelize.getDialect() === 'postgres') {
      await db.sequelize.query("SELECT pg_advisory_xact_lock(hashtext('ayedos_member_number_sequence'))", { transaction });
    }
    const members = await db.Member.findAll({
      attributes: ['memberNumber'],
      where: { memberNumber: { [db.Sequelize.Op.like]: `${PREFIX}-%` } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const highest = members.reduce((max, member) => {
      const match = /^29903-(\d+)$/.exec(String(member.memberNumber || ''));
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    const memberNumber = `${PREFIX}-${String(highest + 1).padStart(5, '0')}`;
    return db.Member.create({ ...data, memberNumber }, { transaction });
  });
}

// Reset is intentionally safe: it is permitted only when no formatted IDs
// exist. Test data can be cleared and the next create naturally returns 00001.
async function canResetToOne() {
  return db.Member.count({ where: { memberNumber: { [db.Sequelize.Op.like]: `${PREFIX}-%` } } }).then((count) => count === 0);
}

module.exports = { PREFIX, createMember, canResetToOne };
