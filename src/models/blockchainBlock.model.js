const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const BlockchainBlock = sequelize.define('BlockchainBlock', {
  id: {
    type: DataTypes.STRING(32),
    primaryKey: true,
  },
  blockNumber: {
    type: DataTypes.BIGINT,
    unique: true,
    allowNull: false,
    field: 'block_number',
  },
  transactionId: {
    type: DataTypes.STRING(64),
    unique: true,
    allowNull: false,
    field: 'transaction_id',
  },
  transactionHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    field: 'transaction_hash',
  },
  previousHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    field: 'previous_hash',
  },
  currentHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    field: 'current_hash',
  },
  merkleRoot: {
    type: DataTypes.STRING(64),
    allowNull: false,
    field: 'merkle_root',
  },
  digitalSignature: {
    type: DataTypes.TEXT,
    allowNull: false,
    field: 'digital_signature',
  },
  validatorNodeId: {
    type: DataTypes.STRING(64),
    allowNull: false,
    field: 'validator_node_id',
  },
}, {
  tableName: 'blockchain_blocks',
  timestamps: true,
  indexes: [
    { fields: ['transactionId'] },
    { fields: ['blockNumber'] },
  ],
});

module.exports = BlockchainBlock;
