const crypto = require('crypto');
const { getFirebaseDb } = require('../config/firebase');

const operatorName = (key) => typeof key === 'symbol'
  ? (Symbol.keyFor(key) || key.description || '').replace(/^sequelize\./, '')
  : key;

const plainValue = (value) => {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (Array.isArray(value)) return value.map(plainValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item)]));
  }
  return value;
};

const clean = (value) => Object.fromEntries(
  Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [
      key,
      item && typeof item === 'object' && !(item instanceof Date) && !Array.isArray(item)
        ? clean(item)
        : item,
    ])
);

const compare = (actual, condition) => {
  if (condition === null || typeof condition !== 'object' || condition instanceof Date || Array.isArray(condition)) {
    return actual === condition;
  }
  return Reflect.ownKeys(condition).every((key) => {
    const expected = condition[key];
    switch (operatorName(key)) {
      case 'eq': return actual === expected;
      case 'ne': return actual !== expected;
      case 'in': return expected.includes(actual);
      case 'notIn': return !expected.includes(actual);
      case 'gt': return actual > expected;
      case 'gte': return actual >= expected;
      case 'lt': return actual < expected;
      case 'lte': return actual <= expected;
      case 'like':
      case 'iLike': {
        const needle = String(expected).replaceAll('%', '');
        return String(actual || '').toLowerCase().includes(needle.toLowerCase());
      }
      case 'is': return expected === null ? actual == null : actual === expected;
      default: return true;
    }
  });
};

const pathValue = (record, path) => path
  .replaceAll('$', '')
  .split('.')
  .reduce((value, key) => value?.[key], record);

const matches = (record, where = {}) => Reflect.ownKeys(where).every((key) => {
  const name = operatorName(key);
  if (name === 'or') return where[key].some((part) => matches(record, part));
  if (name === 'and') return where[key].every((part) => matches(record, part));
  return compare(pathValue(record, String(key)), where[key]);
});

const selectAttributes = (record, attributes) => {
  if (!attributes) return record;
  if (Array.isArray(attributes)) {
    return Object.fromEntries(attributes.filter((key) => key in record).map((key) => [key, record[key]]));
  }
  if (attributes.exclude) {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !attributes.exclude.includes(key)));
  }
  return record;
};

class FirestoreInstance {
  constructor(model, values) {
    this._model = model;
    this._assign(values);
  }

  _assign(values) {
    this.dataValues = plainValue(values);
    Object.assign(this, this.dataValues);
  }

  get(options = {}) {
    return options.plain ? this.toJSON() : this.dataValues;
  }

  toJSON() {
    return plainValue({ ...this.dataValues });
  }

  async update(values) {
    await this._model._document(this.id).set(clean(values), { merge: true });
    this._assign({ ...this.dataValues, ...values, updatedAt: new Date() });
    await this._model._document(this.id).set({ updatedAt: this.updatedAt }, { merge: true });
    return this;
  }

  async save() {
    const assignedValues = Object.fromEntries(
      Object.entries(this).filter(([key]) => key !== '_model' && key !== 'dataValues')
    );
    const values = clean({ ...this.dataValues, ...assignedValues, updatedAt: new Date() });
    await this._model._document(this.id).set(values, { merge: true });
    this._assign(values);
    return this;
  }

  async destroy() {
    await this._model._document(this.id).delete();
  }

  async increment(field, options = {}) {
    const by = options.by ?? 1;
    return this.update({ [field]: Number(this[field] || 0) + by });
  }

  async decrement(field, options = {}) {
    return this.increment(field, { by: -(options.by ?? 1) });
  }
}

class FirestoreModel {
  constructor(name, attributes = {}, options = {}) {
    this.name = name;
    this.attributes = attributes;
    this.options = options;
    this.associations = [];
    this.collectionName = options.tableName || `${name.charAt(0).toLowerCase()}${name.slice(1)}s`;
  }

  _collection() {
    return getFirebaseDb().collection(this.collectionName);
  }

  _document(id) {
    return this._collection().doc(String(id));
  }

  _defaults(values) {
    const output = {};
    for (const [key, definition] of Object.entries(this.attributes)) {
      if (values[key] !== undefined) continue;
      const fallback = definition?.defaultValue;
      if (fallback === undefined) continue;
      if (key === 'id' || fallback?.key === 'UUIDV4') output[key] = crypto.randomUUID();
      else if (fallback?.key === 'NOW') output[key] = new Date();
      else if (typeof fallback === 'function') output[key] = fallback();
      else if (typeof fallback !== 'symbol' && typeof fallback !== 'object') output[key] = fallback;
    }
    return output;
  }

  _instance(values) {
    return new FirestoreInstance(this, values);
  }

  async create(values = {}) {
    const uniqueFields = Object.entries(this.attributes)
      .filter(([, definition]) => definition?.unique && values[definition.fieldName] !== null)
      .map(([field]) => field)
      .filter((field) => values[field] !== undefined);
    for (const field of uniqueFields) {
      const duplicate = await this.findOne({ where: { [field]: values[field] } });
      if (duplicate) {
        const error = new Error(`${this.name}.${field} must be unique`);
        error.name = 'SequelizeUniqueConstraintError';
        throw error;
      }
    }

    const now = new Date();
    const record = clean({
      ...this._defaults(values),
      ...values,
      id: values.id || crypto.randomUUID(),
      createdAt: values.createdAt || now,
      updatedAt: values.updatedAt || now,
    });
    await this._document(record.id).set(record);
    return this._instance(record);
  }

  async bulkCreate(records = []) {
    return Promise.all(records.map((record) => this.create(record)));
  }

  async findByPk(id, options = {}) {
    if (id == null) return null;
    const snapshot = await this._document(id).get();
    if (!snapshot.exists) return null;
    let record = { id: snapshot.id, ...plainValue(snapshot.data()) };
    record = await this._withIncludes(record, options.include);
    return this._instance(selectAttributes(record, options.attributes));
  }

  async findOne(options = {}) {
    const records = await this.findAll({ ...options, limit: 1 });
    return records[0] || null;
  }

  async findOrCreate(options = {}) {
    const where = options.where || {};
    const defaults = options.defaults || {};
    const existing = await this.findOne({ where });
    if (existing) return [existing, false];

    const identity = Object.keys(where)
      .sort()
      .map((key) => `${key}:${JSON.stringify(where[key])}`)
      .join('|');
    const id = defaults.id
      || where.id
      || crypto.createHash('sha256')
        .update(`${this.collectionName}|${identity}`)
        .digest('hex')
        .slice(0, 32);
    const document = this._document(id);

    return getFirebaseDb().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      if (snapshot.exists) {
        return [this._instance({ id: snapshot.id, ...plainValue(snapshot.data()) }), false];
      }

      // Re-check the unique lookup inside the transaction. This handles
      // records created before deterministic findOrCreate IDs were introduced.
      const simpleField = Object.keys(where).find((key) => (
        where[key] === null || ['string', 'number', 'boolean'].includes(typeof where[key])
      ));
      if (simpleField) {
        const query = this._collection().where(simpleField, '==', where[simpleField]).limit(10);
        const matchesSnapshot = await transaction.get(query);
        const match = matchesSnapshot.docs
          .map((item) => ({ id: item.id, ...plainValue(item.data()) }))
          .find((record) => matches(record, where));
        if (match) return [this._instance(match), false];
      }

      const now = new Date();
      const record = clean({
        ...this._defaults({ ...defaults, ...where }),
        ...defaults,
        ...where,
        id,
        createdAt: defaults.createdAt || now,
        updatedAt: defaults.updatedAt || now,
      });
      transaction.create(document, record);
      return [this._instance(record), true];
    });
  }

  async findAll(options = {}) {
    let query = this._collection();
    const simpleEquality = Reflect.ownKeys(options.where || {}).find((key) => {
      if (typeof key === 'symbol' || String(key).includes('.')) return false;
      const value = options.where[key];
      return value === null
        || ['string', 'number', 'boolean'].includes(typeof value)
        || value instanceof Date;
    });
    if (simpleEquality !== undefined) {
      query = query.where(String(simpleEquality), '==', options.where[simpleEquality]);
    }
    const snapshot = await query.get();
    let records = snapshot.docs.map((doc) => ({ id: doc.id, ...plainValue(doc.data()) }));
    if (options.include) {
      records = await Promise.all(records.map((record) => this._withIncludes(record, options.include)));
      records = records.filter(Boolean);
    }
    records = records.filter((record) => matches(record, options.where));
    for (const [field, direction = 'ASC'] of [...(options.order || [])].reverse()) {
      records.sort((a, b) => {
        const left = pathValue(a, field);
        const right = pathValue(b, field);
        return (left > right ? 1 : left < right ? -1 : 0) * (String(direction).toUpperCase() === 'DESC' ? -1 : 1);
      });
    }
    if (options.offset) records = records.slice(options.offset);
    if (options.limit != null) records = records.slice(0, options.limit);
    return records.map((record) => this._instance(selectAttributes(record, options.attributes)));
  }

  async findAndCountAll(options = {}) {
    const all = await this.findAll({ ...options, limit: undefined, offset: undefined });
    const rows = all.slice(options.offset || 0, (options.offset || 0) + (options.limit ?? all.length));
    return { count: all.length, rows };
  }

  async count(options = {}) {
    return (await this.findAll(options)).length;
  }

  async sum(field, options = {}) {
    return (await this.findAll(options)).reduce((total, record) => total + Number(record[field] || 0), 0);
  }

  async update(values, options = {}) {
    const records = await this.findAll({ where: options.where });
    await Promise.all(records.map((record) => record.update(values)));
    return [records.length];
  }

  async destroy(options = {}) {
    const records = await this.findAll({ where: options.where });
    await Promise.all(records.map((record) => record.destroy()));
    return records.length;
  }

  async upsert(values) {
    const existing = values.id ? await this.findByPk(values.id) : null;
    if (existing) {
      await existing.update(values);
      return [existing, false];
    }
    return [await this.create(values), true];
  }

  async increment(field, options = {}) {
    const records = await this.findAll({ where: options.where });
    await Promise.all(records.map((record) => record.increment(field, options)));
    return records;
  }

  hasOne(target, options = {}) { this._associate('hasOne', target, options); }
  hasMany(target, options = {}) { this._associate('hasMany', target, options); }
  belongsTo(target, options = {}) { this._associate('belongsTo', target, options); }

  _associate(type, target, options) {
    this.associations.push({
      type,
      target,
      foreignKey: options.foreignKey,
      as: options.as || (type === 'hasMany' ? `${target.name}s` : target.name),
    });
  }

  async _withIncludes(record, includes) {
    if (!includes) return record;
    const list = Array.isArray(includes) ? includes : [includes];
    const output = { ...record };
    for (const specification of list) {
      const include = specification?.model ? specification : { model: specification };
      const association = this.associations.find((item) =>
        item.target === include.model && (!include.as || item.as === include.as));
      if (!association) continue;
      let related;
      if (association.type === 'belongsTo') {
        related = await include.model.findByPk(record[association.foreignKey], include);
      } else {
        const query = { ...(include.where || {}), [association.foreignKey]: record.id };
        related = association.type === 'hasMany'
          ? await include.model.findAll({ ...include, where: query })
          : await include.model.findOne({ ...include, where: query });
      }
      if (include.required && (!related || (Array.isArray(related) && related.length === 0))) return null;
      output[association.as] = Array.isArray(related)
        ? related.map((item) => item.toJSON())
        : related?.toJSON() || null;
    }
    return output;
  }
}

class FirestoreDatabase {
  constructor() {
    this.models = {};
    this.LOCK = { UPDATE: 'UPDATE' };
  }

  define(name, attributes, options) {
    const model = new FirestoreModel(name, attributes, options);
    this.models[name] = model;
    return model;
  }

  async authenticate() {
    await getFirebaseDb().listCollections();
  }

  async sync() {}
  async close() {}

  async transaction(callback) {
    return callback({ LOCK: this.LOCK });
  }

  getDialect() {
    return 'firestore';
  }

  get config() {
    return { database: process.env.FIREBASE_PROJECT_ID, host: 'firestore.googleapis.com' };
  }
}

module.exports = new FirestoreDatabase();
