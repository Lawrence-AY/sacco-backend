const firestore = require('../firebase/firestoreModel');

module.exports = firestore;
module.exports.testConnection = async () => {
  await firestore.authenticate();
  return true;
};
module.exports.closeConnection = () => firestore.close();
