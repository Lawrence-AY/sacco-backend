const db = require('../../../models');
const { DatabaseError } = require('../../../shared/utils/errors');

const privateUserFields = ['password', 'otp', 'otpExpiresAt', 'passwordResetToken', 'passwordResetExpires'];

const getAllUsers = async () => {
  try {
    return await db.User.findAll({
      attributes: { exclude: privateUserFields },
      include: [{
        model: db.Member,
        attributes: ['id', 'memberNumber', 'type', 'nationalId', 'isVerified'],
      }],
      order: [['createdAt', 'DESC']]
    });
  } catch (error) {
    throw new DatabaseError('Failed to retrieve users', error.message);
  }
};

const getUserById = async (id) => {
  try {
    return await db.User.findByPk(id, {
      attributes: { exclude: privateUserFields },
      include: [{
        model: db.Member,
        attributes: ['id', 'memberNumber', 'type', 'nationalId', 'isVerified'],
      }],
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

    await user.update({
      firstName: data.firstName ?? user.firstName,
      lastName: data.lastName ?? user.lastName,
      name: data.name ?? user.name,
      email: data.email ?? user.email,
      phone: data.phone ?? user.phone,
      role: data.role ?? user.role,
      nationalId: data.nationalId ?? user.nationalId,
      kraPin: data.kraPin ?? user.kraPin,
      occupation: data.occupation ?? user.occupation,
      address: data.address ?? user.address,
      idDocumentUrl: data.idDocumentUrl ?? user.idDocumentUrl,
      passportPhotoUrl: data.passportPhotoUrl ?? user.passportPhotoUrl,
      isVerified: data.isVerified ?? user.isVerified,
      consentGiven: data.consentGiven ?? user.consentGiven,
      consentGivenAt: data.consentGivenAt ?? user.consentGivenAt
    });

    const refreshedUser = await db.User.findByPk(id, {
      attributes: { exclude: privateUserFields },
      include: [{
        model: db.Member,
        attributes: ['id', 'memberNumber', 'type', 'nationalId', 'isVerified'],
      }],
    });

    const result = refreshedUser.toJSON();
    privateUserFields.forEach((field) => delete result[field]);
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
