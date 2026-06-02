const crypto = require('crypto');
const { Queue, Worker } = require('bullmq');
const { Op } = require('sequelize');
const db = require('../../models');
const logger = require('../../shared/utils/logger');
const { sendEmail } = require('./emailProviders');
const { buildOtpEmail, buildPasswordResetEmail } = require('./templates');

const QUEUES = {
  OTP: 'otp-email',
  PASSWORD_RESET: 'password-reset',
  NOTIFICATIONS: 'notifications',
};
const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
const connection = REDIS_URL ? { url: REDIS_URL, maxRetriesPerRequest: null } : null;
const queues = new Map();
let workersStarted = false;
let pollTimer = null;

const encryptionKey = () => crypto
  .createHash('sha256')
  .update(process.env.EMAIL_JOB_ENCRYPTION_KEY || process.env.JWT_SECRET || 'development-only-email-key')
  .digest();

const encrypt = (payload) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
};

const decrypt = (payload) => {
  const [iv, tag, encrypted] = payload.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
};

const getQueue = (queueName) => {
  if (!connection) return null;
  if (!queues.has(queueName)) queues.set(queueName, new Queue(queueName, { connection }));
  return queues.get(queueName);
};

const buildMessage = (job) => {
  if (job.type === 'OTP') {
    return { to: job.to, subject: 'Verification Code (OTP) - AYEDOS SACCO', html: buildOtpEmail(job) };
  }
  if (job.type === 'PASSWORD_RESET') {
    return { to: job.to, subject: 'Reset your AYEDOS password', html: buildPasswordResetEmail(job) };
  }
  return { to: job.to, subject: job.subject, html: job.html };
};

const processEmailJob = async (emailJobId) => {
  const record = await db.EmailJob.findByPk(emailJobId);
  if (!record || record.status === 'SENT') return;
  await record.update({ status: 'PROCESSING', attempts: record.attempts + 1 });
  try {
    const result = await sendEmail(buildMessage(decrypt(record.encryptedPayload)));
    await record.update({
      status: 'SENT',
      provider: result.provider,
      providerMessageId: result.messageId,
      sentAt: new Date(),
      lastError: null,
    });
  } catch (error) {
    const attempts = record.attempts;
    const retryDelayMs = Math.min(30_000 * (2 ** Math.max(attempts - 1, 0)), 15 * 60_000);
    await record.update({
      status: attempts >= 5 ? 'FAILED' : 'PENDING',
      lastError: error.message,
      nextAttemptAt: new Date(Date.now() + retryDelayMs),
    });
    logger.error('Queued email delivery failed', { module: 'email', emailJobId, attempts, error: error.message });
    throw error;
  }
};

const scheduleQueueDelivery = (record) => {
  const queue = getQueue(record.queueName);
  if (!queue) return;
  queue.add(record.type, { emailJobId: record.id }, {
    jobId: record.id,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  }).catch((error) => logger.error('Unable to publish email job to Redis', {
    module: 'email', emailJobId: record.id, error: error.message,
  }));
};

const enqueueEmail = async (queueName, type, payload) => {
  const record = await db.EmailJob.create({ queueName, type, encryptedPayload: encrypt(payload) });
  scheduleQueueDelivery(record);
  logger.info('Email queued', { module: 'email', queueName, type, emailJobId: record.id });
  return record.id;
};

const pollOutbox = async () => {
  const pending = await db.EmailJob.findAll({
    where: { status: 'PENDING', nextAttemptAt: { [Op.lte]: new Date() } },
    order: [['createdAt', 'ASC']],
    limit: 25,
  });
  pending.forEach((record) => {
    if (connection) scheduleQueueDelivery(record);
    else processEmailJob(record.id).catch(() => {});
  });
};

const startEmailWorkers = () => {
  if (workersStarted) return;
  workersStarted = true;
  if (connection) {
    Object.values(QUEUES).forEach((queueName) => {
      const worker = new Worker(queueName, ({ data }) => processEmailJob(data.emailJobId), { connection, concurrency: 10 });
      worker.on('failed', (job, error) => logger.error('Email queue job failed', {
        module: 'email', queueName, emailJobId: job?.data?.emailJobId, error: error.message,
      }));
    });
  } else {
    logger.warn('REDIS_URL is not configured; using single-process email outbox worker');
  }
  pollTimer = setInterval(() => pollOutbox().catch((error) => logger.error('Email outbox poll failed', {
    module: 'email', error: error.message,
  })), 5000);
  pollOutbox().catch(() => {});
};

module.exports = { QUEUES, enqueueEmail, startEmailWorkers };
