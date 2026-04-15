const db = require('../../../shared/config/db');
const { DatabaseError } = require('../../../shared/utils/errors');

const getAllUsers = async () => {
  try {
    return await db.User.findAll({
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']]
    });
  } catch (error) {
    throw new DatabaseError('Failed to retrieve users', error.message);
  }
};

const getUserById = async (id) => {
  try {
    return await db.User.findByPk(id, {
      attributes: { exclude: ['password'] }
    });
  } catch (error) {
    throw new DatabaseError('Failed to retrieve user', error.message);
  }
};

const updateUser = async (id, data) => {
  try {
    const user = await db.User.findByPk(id);
    if (!user) {
      return null;
    }

    const updated = await user.update({
      name: data.name ?? user.name,
      email: data.email ?? user.email,
      phone: data.phone ?? user.phone,
      role: data.role ?? user.role,
      consentGiven: data.consentGiven ?? user.consentGiven,
      consentGivenAt: data.consentGivenAt ?? user.consentGivenAt
    });

    const result = updated.toJSON();
    delete result.password;
    return result;
  } catch (error) {
    throw new DatabaseError('Failed to update user', error.message);
  }
};

const deleteUser = async (id) => {
  try {
    const user = await db.User.findByPk(id);
    if (!user) {
      return false;
    }
    await user.destroy();
    return true;
  } catch (error) {
    throw new DatabaseError('Failed to delete user', error.message);
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser
};