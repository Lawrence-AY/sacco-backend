const crypto = require('crypto');
const { Queue, Worker } = require('bullmq');
const db = require('../../models');
const logger = require('../../shared/utils/logger');
const { sendEmail } = require('./emailProviders');
const { buildOtpEmail, buildPasswordResetEmail, getBrandLogoAttachments } = require('./templates');

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
let outboxUnavailableLogged = false;
let nextOutboxErrorLogAt = 0;

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

const stripHtml = (html) => String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const withTextFallback = (message) => {
  if (message.text || !message.html) return message;
  return { ...message, text: stripHtml(message.html) };
};

const buildMessage = (type, job) => {
  if (type === 'OTP') {
    return withTextFallback({
      to: job.to,
      subject: 'Verification Code (OTP) - AYEDOS SACCO',
      html: buildOtpEmail(job),
      attachments: getBrandLogoAttachments(),
    });
  }
  if (type === 'PASSWORD_RESET') {
    return withTextFallback({
      to: job.to,
      subject: 'Reset your AYEDOS password',
      html: buildPasswordResetEmail(job),
    });
  }
  return withTextFallback({
    to: job.to,
    subject: job.subject,
    html: job.html,
    text: job.text,
    attachments: job.attachments || [],
  });
};

const processEmailJob = async (emailJobId) => {
  const record = await db.EmailJob.findByPk(emailJobId);
  if (!record || record.status === 'SENT') return;
  await record.update({ status: 'PROCESSING', attempts: record.attempts + 1 });
  try {
    const result = await sendEmail(buildMessage(record.type, decrypt(record.encryptedPayload)));
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

const enqueueEmail = async (queueName, type, payload, options = {}) => {
  const record = await db.EmailJob.create({ queueName, type, encryptedPayload: encrypt(payload) });
  if (options.immediate) {
    processEmailJob(record.id).catch(() => {});
  } else {
    scheduleQueueDelivery(record);
  }
  logger.info('Email queued', { module: 'email', queueName, type, emailJobId: record.id });
  return record.id;
};

const pollOutbox = async () => {
  const records = await db.EmailJob.findAll({
    where: { status: 'PENDING' },
    order: [['createdAt', 'ASC']],
  });
  const pending = records
    .filter((record) => {
      const nextAttemptAt = record.nextAttemptAt?.toDate?.()
        || (record.nextAttemptAt instanceof Date ? record.nextAttemptAt : null);
      return !nextAttemptAt || nextAttemptAt <= new Date();
    })
    .slice(0, 25);
  pending.forEach((record) => {
    if (connection) scheduleQueueDelivery(record);
    else processEmailJob(record.id).catch(() => {});
  });
};

const isOutboxStoreUnavailable = (error) => {
  const message = String(error?.message || '');
  return error?.code === 'FIRESTORE_DATABASE_NOT_FOUND'
    || error?.code === 14
    || message.includes('Firestore database was not found')
    || message.includes('14 UNAVAILABLE')
    || message.includes('No connection established')
    || message.includes('ENETUNREACH')
    || message.includes('ECONNREFUSED')
    || message.includes('ETIMEDOUT')
    || message.includes('EAI_AGAIN');
};

const logOutboxPollError = (error) => {
  if (isOutboxStoreUnavailable(error)) {
    if (outboxUnavailableLogged) return;
    outboxUnavailableLogged = true;
    logger.warn('Email outbox polling paused until the backing store is reachable', {
      module: 'email',
      error: error.message,
    });
    return;
  }

  const now = Date.now();
  if (now < nextOutboxErrorLogAt) return;
  nextOutboxErrorLogAt = now + 60_000;
  logger.error('Email outbox poll failed', {
    module: 'email',
    error: error.message,
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
  pollTimer = setInterval(() => pollOutbox().catch(logOutboxPollError), 5000);
  pollOutbox().catch(logOutboxPollError);
};

module.exports = { QUEUES, enqueueEmail, processEmailJob, startEmailWorkers };
