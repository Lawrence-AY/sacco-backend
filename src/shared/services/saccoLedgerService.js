const crypto = require('crypto');
const { Op } = require('sequelize');
const { getFirebaseDb } = require('../config/firebase');
const { AppError } = require('../utils/errors');
const db = require('../../models');

const SUMMARY_COLLECTION = 'saccoLedgerSummaries';
const IMPORT_COLLECTION = 'saccoLedgerImports';

function userDisplayName(user) {
  if (!user) return null;
  return String(user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '').trim() || null;
}

function previewWorkbook(records = [], sourceFile) {
  if (!Array.isArray(records)) throw new TypeError('Workbook records must be an array');
  const normalized = records.map((record, index) => {
    const sheet = String(record?.sheet || '').trim();
    const row = record?.row && typeof record.row === 'object' && !Array.isArray(record.row)
      ? record.row
      : record?.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? record.data
        : null;
    if (!sheet || !row || !Object.keys(row).length) {
      return { error: 'Each workbook row must include a sheet name and row data', rowNumber: record?.rowNumber || index + 1 };
    }
    return {
      sheet,
      rowNumber: Number(record.rowNumber) || index + 1,
      data: row,
      sourceFile: sourceFile || null,
    };
  });

  const sheetCounts = {};
  normalized.filter((record) => !record.error).forEach(({ sheet }) => {
    sheetCounts[sheet] = (sheetCounts[sheet] || 0) + 1;
  });
  return {
    accepted: normalized.filter((record) => !record.error).length,
    rejected: normalized.filter((record) => record.error),
    sheetCounts,
    records: normalized.filter((record) => !record.error).slice(0, 100),
  };
}

async function commitWorkbook(records = [], sourceFile, importedBy, summaries = {}) {
  const preview = previewWorkbook(records, sourceFile);
  if (!preview.accepted) throw new AppError('No workbook rows were supplied.', 400, 'WORKBOOK_VALIDATION_FAILED');
  if (preview.rejected.length) {
    const error = new AppError(`Import stopped: ${preview.rejected.length} workbook rows are invalid. No rows were saved.`, 400, 'WORKBOOK_VALIDATION_FAILED');
    error.details = preview.rejected;
    throw error;
  }

  const writes = preview.records.length === records.length
    ? preview.records
    : records.map((record, index) => ({
      sheet: String(record.sheet).trim(),
      rowNumber: Number(record.rowNumber) || index + 1,
      data: record.row || record.data,
      sourceFile: sourceFile || null,
    }));

  const firebaseDb = getFirebaseDb();
  const importId = crypto.randomUUID();
  const importRef = firebaseDb.collection(IMPORT_COLLECTION).doc(importId);
  const uploader = importedBy ? await db.User.findByPk(importedBy, { attributes: ['id', 'name', 'firstName', 'lastName', 'email'] }) : null;
  const importedByName = userDisplayName(uploader);

  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = firebaseDb.batch();
    writes.slice(offset, offset + 400).forEach((record, index) => {
      const recordNumber = offset + index + 1;
      batch.set(importRef.collection('records').doc(String(recordNumber).padStart(6, '0')), {
        ...record,
        importId,
        importedAt: new Date(),
      });
    });
    await batch.commit();
  }

  await importRef.set({
    importId,
    sourceFile: sourceFile || null,
    importedBy: importedBy || null,
    importedByName,
    recordCount: writes.length,
    sheetCounts: preview.sheetCounts,
    summaries: summaries && typeof summaries === 'object' ? summaries : {},
    createdAt: new Date(),
    status: 'ARCHIVED',
  });

  await firebaseDb.collection(SUMMARY_COLLECTION).doc('current').set({
    importId,
    sourceFile: sourceFile || null,
    importedBy: importedBy || null,
    importedByName,
    recordCount: writes.length,
    sheetCounts: preview.sheetCounts,
    summaries: summaries && typeof summaries === 'object' ? summaries : {},
    createdAt: new Date(),
    updatedAt: new Date(),
    status: 'ARCHIVED',
  }, { merge: true });

  // The monthly contribution sheets contain movements, not running balances.
  // Sum dated columns through the reporting month, then set account snapshots
  // to that total so re-uploads do not add the same movements again.
  let accountImport;
  try {
    accountImport = await applyMemberAccountSnapshots(writes, sourceFile);
  } catch (error) {
    await importRef.set({ status: 'ACCOUNT_UPDATE_FAILED', accountUpdateError: error.message }, { merge: true });
    await firebaseDb.collection(SUMMARY_COLLECTION).doc('current').set({ status: 'ACCOUNT_UPDATE_FAILED' }, { merge: true });
    throw error;
  }

  await importRef.set({ accountImport, status: 'COMPLETED', completedAt: new Date() }, { merge: true });
  await firebaseDb.collection(SUMMARY_COLLECTION).doc('current').set({ accountImport, status: 'COMPLETED' }, { merge: true });

  return { importId, recordCount: writes.length, sheetCounts: preview.sheetCounts, accountImport, rejected: [] };
}

function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseMoney(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  if (!raw || raw === '-' || raw === '—') return 0;
  const negative = /^\(.*\)$/.test(raw);
  const number = Number(raw.replace(/[(),\s]/g, ''));
  return Number.isFinite(number) ? (negative ? -number : number) : null;
}

function monthIndex(header) {
  const text = String(header || '').trim();
  const match = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s/-]+(\d{2,4})$/i);
  if (!match) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[1].slice(0, 3).toLowerCase());
  let year = Number(match[2]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  return year * 12 + month;
}

function reportingMonth(sourceFile) {
  const match = String(sourceFile || '').match(/(20\d{2})[-_ ](0?[1-9]|1[0-2])(?=$|[^0-9])/);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function memberNameFromRow(row) {
  const entry = Object.entries(row || {}).find(([key]) => ['name', 'membername', 'beneficiary'].includes(key.toLowerCase().replace(/[^a-z]/g, '')));
  return entry ? String(entry[1] || '').trim() : '';
}

function memberNumberFromRow(row) {
  const entry = Object.entries(row || {}).find(([key]) => ['membernumber', 'memberno', 'saccomemberno'].includes(key.toLowerCase().replace(/[^a-z]/g, '')));
  return entry ? String(entry[1] || '').trim() : '';
}

function memberNationalIdFromRow(row) {
  const entry = Object.entries(row || {}).find(([key]) => ['nationalid', 'idnumber', 'identitynumber', 'nationalidentificationnumber'].includes(key.toLowerCase().replace(/[^a-z]/g, '')));
  return entry ? String(entry[1] || '').trim() : '';
}

function normalizedMemberNumber(value) {
  const raw = String(value || '').trim().toUpperCase();
  const numbered = raw.match(/^(.*?)[\s_-]+0*(\d+)$/);
  if (numbered) {
    const prefix = numbered[1].replace(/[^A-Z0-9]/g, '');
    const suffix = numbered[2].replace(/^0+/, '') || '0';
    return `${prefix}:${suffix}`;
  }
  return raw.replace(/[^A-Z0-9]/g, '');
}

function normalizedIdentity(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function namesShareFullTokenSet(left, right) {
  const tokenize = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (Math.min(leftTokens.length, rightTokens.length) < 2) return false;
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = new Set(leftTokens.length <= rightTokens.length ? rightTokens : leftTokens);
  return shorter.every((token) => longer.has(token));
}

function rowValue(row, aliases) {
  const aliasSet = aliases.map((value) => value.toLowerCase().replace(/[^a-z]/g, ''));
  const entry = Object.entries(row || {}).find(([key]) => aliasSet.includes(key.toLowerCase().replace(/[^a-z]/g, '')));
  return entry?.[1];
}

function datedMovements(row, cutoff) {
  return Object.entries(row || {}).flatMap(([header, value]) => {
    const month = monthIndex(header);
    if (month === null || month > cutoff) return [];
    const amount = parseMoney(value);
    if (amount === null || amount === 0) return [];
    return [{ month, amount }];
  });
}

function monthEnd(month) {
  const year = Math.floor(month / 12);
  const monthNumber = (month % 12) + 1;
  return new Date(Date.UTC(year, monthNumber, 0, 12));
}

function workbookDate(value, fallbackMonth) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2,4})$/);
  if (match) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(match[2].slice(0, 3).toLowerCase());
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    if (month >= 0) return new Date(Date.UTC(year, month, Number(match[1]), 12));
  }
  return monthEnd(fallbackMonth);
}

function loanRows(rows, cutoff) {
  const loans = [];
  let current = null;
  rows.forEach((row) => {
    const beneficiary = memberNameFromRow(row);
    const reference = String(rowValue(row, ['ref', 'reference']) || '').trim();
    const amount = parseMoney(rowValue(row, ['loan amount', 'amount']));
    if (beneficiary && reference && amount !== null && amount > 0) {
      current = {
        beneficiary,
        reference,
        amount,
        status: String(rowValue(row, ['loan status', 'status']) || '').trim().toUpperCase(),
        interestRate: Number(String(rowValue(row, ['interest / month', 'interest rate']) || '').replace('%', '').trim()) || 0,
        duration: Number(rowValue(row, ['repay period (months)', 'duration', 'period'])) || null,
        schedule: {},
        periodMonths: [],
      };
      loans.push(current);
      return;
    }
    if (!current) return;
    const item = String(rowValue(row, ['items', 'item']) || '').trim().toLowerCase();
    for (const [header, value] of Object.entries(row)) {
      const month = monthIndex(header);
      if (month === null || month > cutoff || value === '' || value === null || value === undefined) continue;
      if (item === 'period') {
        current.periodMonths.push(month);
      } else if (['balance', 'interest', 'principle', 'principal', 'extra pay', 'notes'].includes(item)) {
        const parsed = parseMoney(value);
        if (parsed === null && item !== 'notes') continue;
        current.schedule[month] ||= {};
        current.schedule[month][item] = item === 'notes' ? String(value).trim() : parsed;
      }
    }
  });
  return loans;
}

function sumDatedColumns(row, cutoff) {
  let total = 0;
  let found = false;
  for (const [header, value] of Object.entries(row || {})) {
    const month = monthIndex(header);
    if (month === null || (cutoff !== null && month > cutoff)) continue;
    const amount = parseMoney(value);
    if (amount === null) continue;
    total += amount;
    found = true;
  }
  return found ? total : null;
}

async function applyMemberAccountSnapshots(records, sourceFile) {
  const cutoff = reportingMonth(sourceFile);
  if (cutoff === null) throw new AppError('Workbook filename must include its reporting month, for example 2026-10, before member balances can be updated.', 400, 'WORKBOOK_REPORTING_MONTH_MISSING');
  const sheets = new Map();
  records.forEach((record) => {
    const sheet = String(record.sheet || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (!sheets.has(sheet)) sheets.set(sheet, []);
    sheets.get(sheet).push(record.data || record.row || {});
  });

  const bioRows = sheets.get('biodata') || [];
  const bioIdentityByName = new Map();
  bioRows.forEach((row) => {
    const name = normalizeName(memberNameFromRow(row));
    if (!name) return;
    if (!bioIdentityByName.has(name)) bioIdentityByName.set(name, []);
    bioIdentityByName.get(name).push({ memberNumber: memberNumberFromRow(row), nationalId: memberNationalIdFromRow(row) });
  });
  const bioIdentityForName = (name) => {
    const normalized = normalizeName(name);
    const exact = bioIdentityByName.get(normalized) || [];
    if (exact.length === 1) return exact[0];
    const candidates = [...bioIdentityByName.entries()]
      .filter(([bioName]) => namesShareFullTokenSet(name, bioName))
      .flatMap(([, identities]) => identities);
    const uniqueNumbers = [...new Map(candidates.filter((identity) => identity.memberNumber).map((identity) => [normalizedMemberNumber(identity.memberNumber), identity])).values()];
    const uniqueIds = [...new Map(candidates.filter((identity) => identity.nationalId).map((identity) => [normalizedIdentity(identity.nationalId), identity])).values()];
    return uniqueNumbers.length === 1 ? uniqueNumbers[0] : uniqueIds.length === 1 ? uniqueIds[0] : null;
  };
  const sheetSpecs = [
    { names: ['sharecapital'], field: 'shareCapital', account: 'shares' },
    { names: ['savings'], field: 'savings', account: 'savings' },
    { names: ['employerscontribution'], field: 'employerContribution', account: null },
  ];
  const snapshots = new Map();
  for (const spec of sheetSpecs) {
    const sheetRows = spec.names.flatMap((name) => sheets.get(name) || []);
    for (const row of sheetRows) {
      const name = memberNameFromRow(row);
      const normalized = normalizeName(name);
      // Workbook sheets may include a footer such as "AYEDOS SACCO Count".
      // It is a total row, not an account holder, so never reconcile it.
      if (!normalized || /(?:count|total|subtotal)$/.test(normalized)) continue;
      const amount = sumDatedColumns(row, cutoff);
      if (amount === null) continue;
      const identity = bioIdentityForName(name) || {};
      const existing = snapshots.get(normalized) || { name, memberNumber: identity.memberNumber || '', nationalId: identity.nationalId || '', values: {} };
      existing.values[spec.field] = amount;
      snapshots.set(normalized, existing);
    }
  }
  if (!snapshots.size) throw new AppError('No member monthly balances were found in Share Capital, Savings, or Employer\'s Contribution. No accounts were changed.', 422, 'WORKBOOK_ACCOUNT_DATA_MISSING');

  const members = await db.Member.findAll({ include: [{ model: db.User, attributes: ['name', 'firstName', 'lastName', 'nationalId'] }] });
  const membersByName = new Map();
  const membersByNumber = new Map();
  const membersByMemberNationalId = new Map();
  const membersByUserNationalId = new Map();
  const addToIndex = (index, key, member) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    if (!index.get(key).some((entry) => entry.id === member.id)) index.get(key).push(member);
  };
  members.forEach((member) => {
    const memberNumber = normalizedMemberNumber(member.memberNumber);
    if (memberNumber) {
      if (!membersByNumber.has(memberNumber)) membersByNumber.set(memberNumber, []);
      membersByNumber.get(memberNumber).push(member);
    }
    addToIndex(membersByMemberNationalId, normalizedIdentity(member.nationalId), member);
    addToIndex(membersByUserNationalId, normalizedIdentity(member.User?.nationalId), member);
    const user = member.User || {};
    const names = [user.name, [user.firstName, user.lastName].filter(Boolean).join(' '), member.importProfile?.fullName]
      .map(normalizeName).filter(Boolean);
    names.forEach((name) => addToIndex(membersByName, name, member));
  });

  const nationalIdMatches = (nationalId) => {
    const key = normalizedIdentity(nationalId);
    if (!key) return [];
    const memberMatches = membersByMemberNationalId.get(key) || [];
    const userMatches = membersByUserNationalId.get(key) || [];
    if (memberMatches.length === 1 && userMatches.length === 1 && memberMatches[0].id !== userMatches[0].id) {
      return [...new Map([...memberMatches, ...userMatches].map((member) => [member.id, member])).values()];
    }
    if (userMatches.length === 1) return userMatches;
    if (memberMatches.length === 1) return memberMatches;
    return userMatches.length ? userMatches : memberMatches;
  };
  const memberNameMatches = (name) => {
    const exact = membersByName.get(normalizeName(name)) || [];
    if (exact.length) return exact;
    const candidates = [...membersByName.entries()]
      .filter(([candidateName]) => namesShareFullTokenSet(name, candidateName))
      .flatMap(([, matches]) => matches);
    return [...new Map(candidates.map((member) => [member.id, member])).values()];
  };

  const resolved = [];
  const unmatched = [];
  const ambiguous = [];
  snapshots.forEach((snapshot, name) => {
    const byMemberNumber = snapshot.memberNumber ? membersByNumber.get(normalizedMemberNumber(snapshot.memberNumber)) : null;
    const byNationalId = snapshot.nationalId ? nationalIdMatches(snapshot.nationalId) : null;
    let matches;
    if (byNationalId?.length === 1) {
      matches = byNationalId;
    } else if (byMemberNumber?.length === 1) {
      matches = byMemberNumber;
    } else if (byNationalId?.length) {
      matches = byNationalId;
    } else if (byMemberNumber?.length) {
      matches = byMemberNumber;
    } else {
      matches = memberNameMatches(snapshot.name);
    }
    if (matches.length === 1) resolved.push({ member: matches[0], snapshot });
    else if (matches.length > 1) ambiguous.push(snapshot.name);
    else unmatched.push(snapshot.name);
  });
  if (ambiguous.length) throw new AppError(`Cannot safely update accounts: duplicate member identity matches found (${ambiguous.slice(0, 5).join(', ')}). No accounts were changed. Check the workbook Bio Data member numbers/ID numbers against member profiles.`, 422, 'WORKBOOK_MEMBER_MATCH_AMBIGUOUS');
  if (!resolved.length) throw new AppError(`No workbook members matched existing SACCO members. No accounts were changed (${unmatched.length} unmatched). Check the workbook Bio Data member numbers/ID numbers against member profiles.`, 422, 'WORKBOOK_MEMBERS_UNMATCHED');

  const resolvedByName = new Map(resolved.map((entry) => [normalizeName(entry.snapshot.name), entry]));
  const resolvedByMemberNumber = new Map(resolved.map((entry) => [normalizedMemberNumber(entry.snapshot.memberNumber), entry]).filter(([number]) => number));
  const memberForWorkbookName = (name) => {
    const normalized = normalizeName(name);
    const identity = bioIdentityForName(name) || {};
    const byNationalId = identity.nationalId ? nationalIdMatches(identity.nationalId) : [];
    if (byNationalId.length === 1) return { member: byNationalId[0] };
    const byNumber = identity.memberNumber ? membersByNumber.get(normalizedMemberNumber(identity.memberNumber)) || [] : [];
    if (byNumber.length === 1) return { member: byNumber[0] };
    const byName = memberNameMatches(name);
    if (byName.length === 1) return { member: byName[0] };
    return resolvedByMemberNumber.get(normalizedMemberNumber(identity.memberNumber)) || resolvedByName.get(normalized) || null;
  };
  const monthlyTransactions = [];
  const transactionSheets = [
    { key: 'savings', sheet: 'savings', paymentCategory: 'workbook_savings' },
    { key: 'share_capital', sheet: 'sharecapital', paymentCategory: 'workbook_share_capital' },
    { key: 'employer_contribution', sheet: 'employerscontribution', paymentCategory: 'workbook_employer_contribution' },
  ];
  const periodKey = `${Math.floor(cutoff / 12)}-${String((cutoff % 12) + 1).padStart(2, '0')}`;
  for (const spec of transactionSheets) {
    for (const row of sheets.get(spec.sheet) || []) {
      const resolvedMember = memberForWorkbookName(memberNameFromRow(row));
      if (!resolvedMember) continue;
      datedMovements(row, cutoff).forEach(({ month, amount }) => {
        const year = Math.floor(month / 12);
        const monthNumber = (month % 12) + 1;
        const monthKey = `${year}-${String(monthNumber).padStart(2, '0')}`;
        monthlyTransactions.push({
          memberId: resolvedMember.member.id,
          type: amount < 0 ? 'WITHDRAWAL' : 'DEPOSIT',
          amount: Math.abs(amount),
          method: 'MANUAL',
          status: 'SUCCESS',
          reference: `WB:${periodKey}:${resolvedMember.member.id}:${spec.key}:${monthKey}`,
          description: `${spec.key.replace(/_/g, ' ')} from workbook for ${monthKey}`,
          paymentCategory: spec.paymentCategory,
          createdAt: monthEnd(month),
          updatedAt: monthEnd(month),
        });
      });
    }
  }
  for (const [index, row] of (sheets.get('sao') || sheets.get('soamoneymovementinout') || []).entries()) {
    const moneyIn = parseMoney(rowValue(row, ['money in', 'cash in']));
    const moneyOut = parseMoney(rowValue(row, ['money out', 'cash out']));
    const amountIn = moneyIn === null ? 0 : moneyIn;
    const amountOut = moneyOut === null ? 0 : moneyOut;
    if (!amountIn && !amountOut) continue;
    const date = workbookDate(rowValue(row, ['date', 'transaction date']), cutoff);
    const payer = String(rowValue(row, ['payer']) || '').trim();
    const beneficiary = String(rowValue(row, ['beneficiary', 'payee']) || '').trim();
    const description = String(rowValue(row, ['description', 'narration', 'particulars']) || '').trim();
    const common = {
      memberId: null,
      method: 'MANUAL',
      status: 'SUCCESS',
      paymentCategory: 'workbook_sao',
      reference: `WB:${periodKey}:SOA:${String(index + 1).padStart(4, '0')}`,
      createdAt: date,
      updatedAt: date,
    };
    const parties = [payer && `From ${payer}`, beneficiary && `To ${beneficiary}`].filter(Boolean).join(' ');
    if (amountIn) monthlyTransactions.push({ ...common, type: 'DEPOSIT', amount: Math.abs(amountIn), description: [parties, description].filter(Boolean).join(' · ') || 'Workbook SOA money in' });
    if (amountOut) monthlyTransactions.push({ ...common, type: 'WITHDRAWAL', amount: Math.abs(amountOut), description: [parties, description].filter(Boolean).join(' · ') || 'Workbook SOA money out' });
  }
  const importedLoans = loanRows(sheets.get('loanaccount') || [], cutoff).flatMap((loan) => {
    const matched = memberForWorkbookName(loan.beneficiary);
    if (!matched) return [];
    const marker = `[WORKBOOK_LOAN:${normalizedMemberNumber(loan.reference)}:${matched.member.id}]`;
    const scheduledMonths = loan.periodMonths.sort((left, right) => left - right);
    const lastMonth = scheduledMonths[scheduledMonths.length - 1];
    const schedule = lastMonth === undefined ? {} : loan.schedule[lastMonth] || {};
    const closed = loan.status.includes('CLOSED') || loan.status.includes('PAID');
    return [{
      ...loan,
      memberId: matched.member.id,
      marker,
      principalBalance: closed ? 0 : Math.max(0, schedule.balance ?? loan.amount),
      accruedInterest: closed || String(schedule.notes || '').toLowerCase().includes('paid') ? 0 : Math.max(0, schedule.interest || 0),
      status: closed ? 'COMPLETED' : 'ACTIVE',
    }];
  });

  let importedRepayments = 0;
  const applied = await db.sequelize.transaction(async (transaction) => {
    await db.Transaction.destroy({
      where: { reference: { [Op.like]: `WB:${periodKey}:%` } },
      transaction,
    });
    if (monthlyTransactions.length) await db.Transaction.bulkCreate(monthlyTransactions, { transaction });
    const existingLoans = await db.Loan.findAll({ transaction });
    for (const loan of importedLoans) {
      let existingLoan = existingLoans.find((row) => String(row.reason || '').includes(loan.marker));
      if (!existingLoan) {
        const similar = existingLoans.filter((row) => row.memberId === loan.memberId
          && Math.abs(Number(row.amount || 0) - loan.amount) < 0.01
          && String(row.status || '').toUpperCase() === loan.status);
        if (similar.length === 1) existingLoan = similar[0];
      }
      const values = {
        memberId: loan.memberId,
        amount: loan.amount,
        principalBalance: loan.principalBalance,
        accruedInterest: loan.accruedInterest,
        interestRate: loan.interestRate,
        duration: loan.duration,
        status: loan.status,
        reason: existingLoan?.reason && String(existingLoan.reason).includes(loan.marker)
          ? existingLoan.reason
          : `${existingLoan?.reason ? `${existingLoan.reason} ` : ''}${loan.marker} Imported from ${sourceFile} (workbook reference ${loan.reference})`,
      };
      if (existingLoan) {
        await existingLoan.update(values, { transaction });
        loan.databaseId = existingLoan.id;
      }
      else {
        const created = await db.Loan.create(values, { transaction });
        existingLoans.push(created);
        loan.databaseId = created.id;
      }
    }
    const repaymentTransactions = [];
    importedLoans.forEach((loan) => {
      loan.periodMonths.forEach((month) => {
        const schedule = loan.schedule[month] || {};
        if (!String(schedule.notes || '').toLowerCase().includes('paid')) return;
        const principal = Number(schedule.principle ?? schedule.principal ?? 0) || 0;
        const interest = Number(schedule.interest || 0) || 0;
        const extra = Number(schedule['extra pay'] || 0) || 0;
        const amount = principal + interest + extra;
        if (amount <= 0) return;
        const monthKey = `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}`;
        repaymentTransactions.push({
          memberId: loan.memberId,
          loanId: loan.databaseId,
          type: 'LOAN_REPAYMENT',
          amount,
          method: 'MANUAL',
          status: 'SUCCESS',
          reference: `WB:${periodKey}:${loan.memberId}:loan:${normalizedMemberNumber(loan.reference)}:${monthKey}`,
          description: `Loan repayment from workbook reference ${loan.reference} for ${monthKey}`,
          paymentCategory: 'workbook_loan_repayment',
          createdAt: monthEnd(month),
          updatedAt: monthEnd(month),
        });
      });
    });
    importedRepayments = repaymentTransactions.length;
    if (repaymentTransactions.length) await db.Transaction.bulkCreate(repaymentTransactions, { transaction });
    let updated = 0;
    let accountsUpdated = 0;
    for (const { member, snapshot } of resolved) {
      const values = snapshot.values;
      const memberUpdate = {};
      ['shareCapital', 'savings', 'employerContribution'].forEach((field) => {
        if (values[field] !== undefined) memberUpdate[field] = values[field];
      });
      await member.update({ ...memberUpdate, importProfile: {
        ...(member.importProfile || {}),
        workbookBalanceSnapshot: { sourceFile, reportingMonth: cutoff, values: { ...(member.importProfile?.workbookBalanceSnapshot?.values || {}), ...values }, importedAt: new Date().toISOString() },
      } }, { transaction });

      if (values.savings !== undefined) {
        const [account] = await db.SavingsAccount.findOrCreate({ where: { memberId: member.id }, defaults: { memberId: member.id, balance: 0 }, transaction });
        await account.update({ balance: values.savings }, { transaction });
        accountsUpdated += 1;
      }
      if (values.shareCapital !== undefined) {
        const [account] = await db.ShareAccount.findOrCreate({ where: { memberId: member.id }, defaults: { memberId: member.id, shares: 0, shareValue: 100 }, transaction });
        const shareValue = Number(account.shareValue) || 100;
        await account.update({ shares: values.shareCapital / shareValue }, { transaction });
        accountsUpdated += 1;
      }
      updated += 1;
    }
    return { updatedMembers: updated, updatedAccounts: accountsUpdated };
  });
  return { reportingMonth: periodKey, matchedMembers: applied.updatedMembers, unmatchedMembers: unmatched.length, unmatchedMemberNames: [...new Set(unmatched)].sort(), updatedAccounts: applied.updatedAccounts, importedTransactions: monthlyTransactions.length + importedRepayments, importedLoans: importedLoans.length, importedRepayments, sourceSheets: ['Share Capital', 'Savings', "Employer's Contribution", 'Loan Account', 'SAO (Money Movement In/Out)'] };
}

async function getCurrentWorkbookSummary() {
  const firebaseDb = getFirebaseDb();
  const snapshot = await firebaseDb.collection(SUMMARY_COLLECTION).doc('current').get();
  return snapshot.exists ? snapshot.data() : null;
}

async function applyArchivedWorkbookImport(importId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(importId || ''))) throw new Error('Invalid workbook import ID');
  const firebaseDb = getFirebaseDb();
  const importRef = firebaseDb.collection(IMPORT_COLLECTION).doc(importId);
  const importSnapshot = await importRef.get();
  if (!importSnapshot.exists) throw new Error('Workbook import not found');
  const importData = importSnapshot.data();
  const recordsSnapshot = await importRef.collection('records').get();
  const records = recordsSnapshot.docs
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((doc) => doc.data());
  if (!records.length) throw new Error('This archived import has no stored workbook rows to apply');
  let accountImport;
  try {
    accountImport = await applyMemberAccountSnapshots(records, importData.sourceFile);
  } catch (error) {
    await importRef.set({ status: 'ACCOUNT_UPDATE_FAILED', accountUpdateError: error.message }, { merge: true });
    throw error;
  }
  await importRef.set({ accountImport, status: 'COMPLETED', completedAt: new Date(), accountUpdateError: null }, { merge: true });
  await firebaseDb.collection(SUMMARY_COLLECTION).doc('current').set({ importId, sourceFile: importData.sourceFile || null, summaries: importData.summaries || {}, accountImport, status: 'COMPLETED', updatedAt: new Date() }, { merge: true });
  return { importId, accountImport };
}

const serializeTimestamp = (value) => (value?.toDate ? value.toDate().toISOString() : value || null);

async function listWorkbookImports(limit = 25) {
  const firebaseDb = getFirebaseDb();
  const snapshot = await firebaseDb.collection(IMPORT_COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
  const imports = snapshot.docs.map((doc) => ({ ...doc.data(), importId: doc.id }));
  const uploaderIds = [...new Set(imports.map((item) => item.importedBy).filter(Boolean))];
  const users = uploaderIds.length
    ? await db.User.findAll({ where: { id: { [Op.in]: uploaderIds } }, attributes: ['id', 'name', 'firstName', 'lastName', 'email'] })
    : [];
  const namesById = new Map(users.map((user) => [user.id, userDisplayName(user)]));
  return imports.map((item) => ({
    ...item,
    importedByName: item.importedByName || namesById.get(item.importedBy) || null,
    createdAt: serializeTimestamp(item.createdAt),
  }));
}

async function getWorkbookImport(importId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(importId || ''))) throw new Error('Invalid workbook import ID');
  const firebaseDb = getFirebaseDb();
  const importRef = firebaseDb.collection(IMPORT_COLLECTION).doc(importId);
  const importSnapshot = await importRef.get();
  if (!importSnapshot.exists) return null;
  const importData = importSnapshot.data();
  const uploader = importData.importedBy && !importData.importedByName
    ? await db.User.findByPk(importData.importedBy, { attributes: ['id', 'name', 'firstName', 'lastName', 'email'] })
    : null;
  const recordsSnapshot = await importRef.collection('records').get();
  const records = recordsSnapshot.docs
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((doc) => ({ id: doc.id, ...doc.data(), importedAt: serializeTimestamp(doc.data().importedAt) }));
  return {
    import: {
      ...importData,
      importedByName: importData.importedByName || userDisplayName(uploader),
      importId: importSnapshot.id,
      createdAt: serializeTimestamp(importData.createdAt),
    },
    records,
  };
}

async function getLedgerForUser(userId) {
  const db = getFirebaseDb();
  const memberSnap = await db.collection('members').where('userId', '==', String(userId)).limit(1).get();
  const memberId = memberSnap.docs[0]?.id || userId;
  const snap = await db.collection('saccoLedgers').doc(String(memberId)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

module.exports = { previewWorkbook, commitWorkbook, listWorkbookImports, getWorkbookImport, applyArchivedWorkbookImport, getCurrentWorkbookSummary, getLedgerForUser };
