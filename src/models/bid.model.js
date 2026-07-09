const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const Bid = sequelize.define('Bid', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  listingId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  bidderId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  bidderMemberNumber: {
    type: DataTypes.STRING,
    allowNull: false
  },
  bidderName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  amount: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'),
    defaultValue: 'PENDING'
  },
  acceptedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  timestamps: true,
  indexes: [
    { fields: ['listingId'] },
    { fields: ['bidderId'] },
    { fields: ['status'] },
    { fields: ['createdAt'] },
  ],
});

module.exports = Bid;