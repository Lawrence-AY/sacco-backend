const db = require('../../../models');

async function findMemberByUserId(userId) {
  return db.Member.findOne({ where: { userId } });
}

async function getShareAccountsForUser(user) {
  const include = [
    {
      model: db.Member,
      include: [
        {
          model: db.User,
          attributes: { exclude: ['password'] },
        },
      ],
    },
  ];

  if (user.role === 'MEMBER') {
    const member = await findMemberByUserId(user.id);

    if (!member) {
      return [];
    }

    return db.ShareAccount.findAll({
      where: { memberId: member.id },
      include,
      order: [['createdAt', 'DESC']],
    });
  }

  return db.ShareAccount.findAll({
    include,
    order: [['createdAt', 'DESC']],
  });
}

module.exports = {
  getShareAccountsForUser,
};
