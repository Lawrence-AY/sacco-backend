const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const displayLabel = (value) => String(value || '-')
  .replace(/loan_repayments?/gi, 'loan repayment')
  .replace(/_/g, ' ');

const formatMoney = (value) => Number(value || 0).toLocaleString(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatDateTime = (value) => {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

const category = (transaction) => displayLabel(
  transaction.paymentCategory
  || transaction.kcbEndpoint
  || transaction.description
  || transaction.type,
).toLowerCase();

const matchingTransactions = (transactions, tokens) => transactions.filter((transaction) => {
  const value = category(transaction);
  return tokens.some((token) => value.includes(token));
});

const phoneFromCheckoutRequestId = (checkoutRequestId) => {
  const digits = String(checkoutRequestId || '').replace(/\D/g, '');
  return digits.length >= 9 ? `+254${digits.slice(-9)}` : '';
};

const transactionPhone = (transaction) => phoneFromCheckoutRequestId(transaction.checkoutRequestId)
  || transaction.phoneNumber
  || transaction.msisdn
  || transaction.customerPhone
  || transaction.memberPhone
  || transaction.sourcePhone
  || transaction.senderPhone
  || transaction.User?.phone
  || transaction.Member?.User?.phone
  || '-';

const transactionKind = (transaction) => {
  const value = category(transaction);
  if (value.includes('loan')) return 'Loan repayment';
  if (value.includes('share')) return 'Share capital';
  if (value.includes('saving') || value.includes('monthly')) return 'Savings';
  if (value.includes('withdraw')) return 'Withdrawal';
  if (value.includes('deposit')) return 'Deposit';
  return displayLabel(transaction.paymentCategory || transaction.kcbEndpoint || transaction.type);
};

const transactionDetails = (transaction) => {
  const value = category(transaction);
  if (value.includes('withdraw')) return `Withdrawn from ${transaction.sourceAccount || transaction.accountName || transaction.walletName || 'member account'}`;
  return `Deposited to ${transaction.destinationAccount || transaction.accountName || transaction.walletName || transactionKind(transaction).toLowerCase()}`;
};

const guarantorName = (guarantor) => guarantor.Member?.User?.name
  || guarantor.Member?.User?.fullName
  || guarantor.Member?.memberNumber
  || guarantor.name
  || guarantor.memberNumber
  || '-';

const reportNames = {
  portfolio: 'Portfolio Report',
  transactions: 'Transaction Statement',
  loans: 'Full Loans Report',
  savings: 'Savings and Share Capital Report',
  'shares-savings': 'Savings and Share Capital Report',
  withdrawals: 'Withdrawals Report',
  'loan-repayment': 'Loan Repayment Report',
  guarantor: 'Guarantor Report',
  'payroll-deduction': 'Payroll Deduction Report',
};

const buildReportSections = ({ reportType, transactions, loans, shares }) => {
  const successfulTransactions = transactions || [];
  const loanSections = () => {
    const repayments = matchingTransactions(successfulTransactions, ['repayment', 'loan repayment', 'loan']);
    return [
      {
        title: 'Loans',
        columns: ['Date & Time', 'Type', 'Amount', 'Guarantor', 'Status', 'Loan Duration', 'Interest to be Paid', 'Reason'],
        rows: (loans || []).map((loan) => ({
          Type: displayLabel(loan.type || 'Loan'),
          Amount: `KES ${formatMoney(loan.amount)}`,
          'Date & Time': formatDateTime(loan.createdAt),
          Guarantor: (loan.Guarantors || []).length ? `${loan.Guarantors.length} guarantors` : loan.selfGuaranteed ? 'Self-guaranteed' : '-',
          Status: displayLabel(loan.status),
          'Loan Duration': loan.duration ? `${loan.duration} months` : '-',
          'Interest to be Paid': `KES ${formatMoney((Number(loan.amount || 0) * Number(loan.interestRate || 0) / 100) * Number(loan.duration || 0))}`,
          Reason: loan.reason || '-',
        })),
      },
      {
        title: 'Loan Repayment',
        columns: ['Date', 'Amount', 'Balance', 'Duration Remaining', 'Interest', 'Reference'],
        rows: repayments.map((transaction) => ({
          Amount: `KES ${formatMoney(transaction.amount)}`,
          Balance: `KES ${formatMoney(transaction.balance || transaction.outstandingBalance || transaction.remainingBalance || 0)}`,
          'Duration Remaining': '-',
          Interest: '-',
          Reference: transaction.reference || '-',
          Date: formatDateTime(transaction.createdAt),
        })),
      },
      {
        title: 'Guarantor',
        columns: ['Guarantor Name', 'Guaranteed Amount', 'Status', 'Guaranteed Loan Type'],
        rows: (loans || []).flatMap((loan) => (loan.Guarantors || []).map((guarantor) => ({
          'Guarantor Name': guarantorName(guarantor),
          'Guaranteed Amount': `KES ${formatMoney(guarantor.amount)}`,
          Status: displayLabel(guarantor.status),
          'Guaranteed Loan Type': displayLabel(loan.type),
        }))),
      },
      {
        title: 'Withdrawals',
        columns: ['Date & Time', 'Destination Device', 'Reference', 'Amount', 'Type'],
        rows: matchingTransactions(successfulTransactions, ['withdraw']).map((transaction) => ({
          'Date & Time': formatDateTime(transaction.createdAt),
          'Destination Device': transaction.promptChannel || transaction.method || '-',
          Reference: transaction.reference || '-',
          Amount: `KES ${formatMoney(transaction.amount)}`,
          Type: displayLabel(transaction.type),
        })),
      },
    ];
  };

  const sectionsByType = {
    transactions: [{
      title: 'Transactions',
      columns: ['Date & Time', 'Phone Number', 'Details', 'Reference', 'Amount'],
      rows: successfulTransactions
        .map((transaction) => ({
          'Date & Time': formatDateTime(transaction.createdAt),
          'Phone Number': transactionPhone(transaction),
          Details: transactionDetails(transaction),
          Reference: transaction.reference || transaction.internalReference || '-',
          Amount: `KES ${formatMoney(transaction.amount)}`,
        })),
    }],
    loans: loanSections(),
    'loan-repayment': [loanSections()[1]],
    guarantor: [loanSections()[2]],
    withdrawals: [loanSections()[3]],
    savings: [{
      title: 'Savings and Share Capital',
      columns: ['Date', 'Record', 'Amount', 'Status'],
      rows: [
        ...(shares || []).map((share) => ({ Record: 'Share capital', Amount: `KES ${formatMoney((share.shares || 0) * (share.shareValue || 0))}`, Status: 'Active', Date: formatDateTime(share.createdAt) })),
        ...matchingTransactions(successfulTransactions, ['savings']).map((transaction) => ({ Record: displayLabel(transaction.paymentCategory), Amount: `KES ${formatMoney(transaction.amount)}`, Status: displayLabel(transaction.status), Date: formatDateTime(transaction.createdAt) })),
      ],
    }],
    'payroll-deduction': [{
      title: 'Payroll Deductions',
      columns: ['Date', 'Reference', 'Amount', 'Status'],
      rows: matchingTransactions(successfulTransactions, ['payroll', 'salary', 'employer']).map((transaction) => ({ Date: formatDateTime(transaction.createdAt), Reference: transaction.reference || '-', Amount: `KES ${formatMoney(transaction.amount)}`, Status: displayLabel(transaction.status) })),
    }],
  };
  sectionsByType['shares-savings'] = sectionsByType.savings;

  return sectionsByType[reportType] || [
    ...sectionsByType.transactions,
    ...loanSections(),
    ...sectionsByType.savings,
    ...sectionsByType['payroll-deduction'],
  ];
};

const buildReportHtml = ({ reportName, durationLabel, summaryRows, sections }) => `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#24384d">
    <h2 style="margin:0 0 6px;color:#24384d">${escapeHtml(reportName)}</h2>
    <p style="margin:0 0 18px;color:#64748b">Period: ${escapeHtml(durationLabel)}</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 22px">
      ${summaryRows.map(([label, value]) => `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #e6edf5;color:#64748b;font-size:13px;font-weight:700">${escapeHtml(label)}</td>
          <td style="padding:9px 0;border-bottom:1px solid #e6edf5;color:#24384d;font-size:13px;text-align:right;font-weight:800">${escapeHtml(value)}</td>
        </tr>
      `).join('')}
    </table>
    ${sections.map((section) => `
      <h3 style="margin:22px 0 10px;color:#24384d;font-size:16px">${escapeHtml(section.title)}</h3>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f7f9fc">${section.columns.map((column) => `<th style="padding:9px;border:1px solid #e6edf5;text-align:left;color:#475569">${escapeHtml(column)}</th>`).join('')}</tr></thead>
        <tbody>${section.rows.length ? section.rows.map((row) => `<tr>${section.columns.map((column) => `<td style="padding:9px;border:1px solid #e6edf5;color:#334155">${escapeHtml(row[column] || '-')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${section.columns.length}" style="padding:12px;border:1px solid #e6edf5;color:#64748b">No records found.</td></tr>`}</tbody>
      </table>
    `).join('')}
  </div>
`;

module.exports = {
  buildReportHtml,
  buildReportSections,
  displayLabel,
  formatMoney,
  reportNames,
};
