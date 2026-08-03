const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const Wallet = sequelize.define('Wallet', {
  id: {
    type: DataTypes.STRING(32),
    primaryKey: true,
    field: 'wallet_id',
  },
  walletId: {
    type: DataTypes.STRING(32),
    unique: true,
  },
  memberId: {
    type: DataTypes.STRING(32),
    unique: true,
    allowNull: false,
    field: 'member_id',
  },
  depositedBalance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0.00,
    allowNull: false,
    field: 'deposited_balance',
  },
  withdrawableBalance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0.00,
    allowNull: false,
    field: 'withdrawable_balance',
  },
  status: {
    type: DataTypes.ENUM('ACTIVE', 'FROZEN', 'SUSPENDED'),
    defaultValue: 'ACTIVE',
    allowNull: false,
  },
}, {
  tableName: 'wallets',
  timestamps: true,
  indexes: [
    { fields: ['walletId'] },
    { fields: ['memberId'] },
    { fields: ['status'] },
  ],
});

module.exports = Wallet;
