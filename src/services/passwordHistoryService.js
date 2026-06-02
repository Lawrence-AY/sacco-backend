const bcrypt = require('bcrypt');
const db = require('../models');
const { ValidationError } = require('../shared/utils/errors');

const HISTORY_LIMIT = Number(process.env.PASSWORD_HISTORY_LIMIT || 5);

const assertNotReused = async (userId, password) => {
  const user = await db.User.findByPk(userId);
  if (user?.password && await bcrypt.compare(password, user.password)) {
    throw new ValidationError(`Choose a password you have not used in your last ${HISTORY_LIMIT} changes`);
  }
  const recent = await db.PasswordHistory.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: HISTORY_LIMIT });
  for (const record of recent) {
    if (await bcrypt.compare(password, record.passwordHash)) {
      throw new ValidationError(`Choose a password you have not used in your last ${HISTORY_LIMIT} changes`);
    }
  }
};

const recordPassword = (userId, passwordHash) => db.PasswordHistory.create({ userId, passwordHash });

module.exports = { assertNotReused, recordPassword };
