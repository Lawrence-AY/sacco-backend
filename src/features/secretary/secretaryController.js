const asyncHandler = require('../../shared/utils/asyncHandler');
const ResponseHandler = require('../../shared/utils/response');
const { ForbiddenError, NotFoundError, ValidationError } = require('../../shared/utils/errors');
const { UserDTO } = require('../../shared/utils/dtos');
const db = require('../../models');
const notificationService = require('../notifications/services/notificationService');
const { getFirebaseStorage } = require('../../shared/config/firebase');

const parseDataUrl = (value) => {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(value || ''));
  if (!match) return null;
  const extension = (match[1].split('/').pop() || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1], extension };
};

const storeSecretaryDocument = async (userId, fileName, dataUrl) => {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed || !parsed.buffer.length) throw new ValidationError('The selected document is invalid or unreadable');
  const safeName = String(fileName || `document.${parsed.extension}`).replace(/[^a-z0-9._-]/gi, '_');
  const objectPath = `secretary/${userId}/documents/${Date.now()}-${safeName}`;
  const file = getFirebaseStorage().bucket().file(objectPath);
  await file.save(parsed.buffer, { contentType: parsed.contentType, metadata: { cacheControl: 'private, max-age=3600' } });
  const [url] = await file.getSignedUrl({ action: 'read', expires: '2500-01-01' });
  return { url, size: parsed.buffer.length, contentType: parsed.contentType, fileName: safeName };
};

const secretaryOnly = (req) => {
  if (!['SECRETARY', 'SUPERADMIN'].includes(String(req.user.role).toUpperCase())) throw new ForbiddenError('Secretary access required');
};

const listMembers = asyncHandler(async (req, res) => {
  secretaryOnly(req);
  const members = await db.Member.findAll({ include: [{ model: db.User, attributes: ['id', 'name', 'firstName', 'lastName', 'email', 'phone', 'nationalId', 'role', 'isVerified'] }], order: [['createdAt', 'DESC']] });
  const directory = members.map((member) => ({
    id: member.User?.id || member.userId,
    name: member.User?.name || [member.User?.firstName, member.User?.lastName].filter(Boolean).join(' '),
    email: member.User?.email || '', phone: member.User?.phone || '', nationalId: member.User?.nationalId || member.nationalId || '',
    role: member.User?.role || 'MEMBER', memberNumber: member.memberNumber || '', status: member.status || 'ACTIVE',
    isVerified: Boolean(member.isVerified || member.User?.isVerified), dateJoined: member.dateJoined || member.createdAt,
    Member: { memberNumber: member.memberNumber || '', status: member.status || 'ACTIVE' },
  }));
  return ResponseHandler.success(res, directory, 'Full member register retrieved');
});

const listRecords = asyncHandler(async (req, res) => {
  secretaryOnly(req);
  const where = req.query.kind ? { kind: String(req.query.kind).toUpperCase() } : {};
  return ResponseHandler.success(res, await db.SecretaryRecord.findAll({ where, order: [['createdAt', 'DESC']] }), 'Secretary records retrieved');
});

const createRecord = asyncHandler(async (req, res) => {
  secretaryOnly(req);
  const { kind, title, status, payload } = req.body;
  if (!['MEETING', 'DOCUMENT'].includes(String(kind).toUpperCase()) || !title) throw new ValidationError('Record kind and title are required');
  const normalizedKind = String(kind).toUpperCase();
  let meetingPayload = normalizedKind === 'MEETING' ? { ...(payload || {}), participantUserIds: [...new Set(Array.isArray(payload?.participantUserIds) ? payload.participantUserIds.filter(Boolean) : [])] } : { ...(payload || {}) };
  if (normalizedKind === 'DOCUMENT') {
    const dataUrl = String(meetingPayload.dataUrl || '');
    if (!dataUrl) throw new ValidationError('Select a document before saving it to the repository');
    if (dataUrl.length > 21_000_000) throw new ValidationError('Document is too large. Please use a file smaller than 15 MB');
    const stored = await storeSecretaryDocument(req.user.id, meetingPayload.fileName, dataUrl);
    delete meetingPayload.dataUrl;
    meetingPayload = { ...meetingPayload, ...stored };
  }
  const record = await db.SecretaryRecord.create({ kind: normalizedKind, title, status: status || 'PUBLISHED', payload: meetingPayload, createdById: req.user.id });
  if (normalizedKind === 'MEETING' && meetingPayload.notifyMembers !== false) {
    try {
      const audience = meetingPayload.audience === 'SELECTED' ? 'SELECTED' : 'MEMBERS';
      await notificationService.createManualNotification(req.user, {
        audience,
        recipientUserIds: audience === 'SELECTED' ? meetingPayload.participantUserIds : undefined,
        title: `Meeting notice: ${title}`,
        body: `A ${meetingPayload.meetingType || 'SACCO meeting'} is scheduled for ${meetingPayload.date || 'a date to be confirmed'}. ${meetingPayload.agenda ? `Agenda: ${meetingPayload.agenda}` : ''}`.trim(),
        category: 'MEETING',
        sourceType: 'SecretaryRecord',
        sourceId: record.id,
      });
    } catch (error) {
      await record.destroy();
      throw error;
    }
  }
  return ResponseHandler.success(res, record, 'Secretary record created', 201);
});

const updateRecord = asyncHandler(async (req, res) => {
  secretaryOnly(req);
  const record = await db.SecretaryRecord.findByPk(req.params.id);
  if (!record) throw new NotFoundError('Secretary record not found');
  await record.update({ title: req.body.title ?? record.title, status: req.body.status ?? record.status, payload: req.body.payload ?? record.payload });
  if (record.kind === 'MEETING' && String(record.status).toUpperCase() === 'PUBLISHED' && record.payload?.agmReport) {
    await notificationService.createManualNotification(req.user, { audience: record.payload.audience || 'ALL', title: record.title, body: record.payload.agmReport, category: 'AGM', sourceType: 'SecretaryRecord', sourceId: record.id });
  }
  return ResponseHandler.success(res, record, 'Secretary record updated');
});

const deleteRecord = asyncHandler(async (req, res) => {
  secretaryOnly(req);
  const record = await db.SecretaryRecord.findByPk(req.params.id);
  if (!record) throw new NotFoundError('Secretary record not found');
  await record.destroy();
  return ResponseHandler.noContent(res);
});

const sendNotice = asyncHandler(async (req, res) => {
  secretaryOnly(req);
  const result = await notificationService.createManualNotification(req.user, req.body);
  return ResponseHandler.success(res, result, 'Notice sent successfully', 201);
});

module.exports = { listMembers, listRecords, createRecord, updateRecord, deleteRecord, sendNotice };
