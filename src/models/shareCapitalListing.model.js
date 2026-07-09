const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const ShareCapitalListing = sequelize.define('ShareCapitalListing', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  amount: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('ACTIVE', 'LOCKED', 'COMPLETED', 'CANCELLED'),
    defaultValue: 'ACTIVE'
  },
  selectedBidId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  settledPrice: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  managementFee: {
    type: DataTypes.FLOAT,
    allowNull: true,
    comment: '1% fee calculated on settled price'
  },
  sellerPayout: {
    type: DataTypes.FLOAT,
    allowNull: true,
    comment: 'Amount seller receives after 1% management fee deduction'
  },
  buyerMemberNumber: {
    type: DataTypes.STRING,
    allowNull: true
  },
  completedAt: {
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
    { fields: ['memberId'] },
    { fields: ['status'] },
    { fields: ['createdAt'] },
  ],
});

module.exports = ShareCapitalListing;