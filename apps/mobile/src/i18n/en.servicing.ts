/**
 * English text for loans, schedule, activity, statements, quotations, closure and reminders (keys `loans.*` and
 * `reminders.*`). Phase 08a screens, builder u1.
 *
 * Wording rules kept in every line: plain and calm; every figure is the lender's and says so; a figure that is withheld is never
 * written as zero; a payment is "received by the payment provider" before it is "posted by the lender", and nothing is called
 * "paid" or "successful"; no countdowns, no urgency, no offers; nothing says that this app approved, verified, released or
 * guaranteed anything, and nothing claims compliance.
 */
export const enServicing = {
  // ---- entry points -----------------------------------------------------------------------------------------------
  'loans.entry': 'My loans',
  'loans.entry.note':
    'See your loans as your lenders report them, and the messages lenders sent you.',
  'loans.title': 'My loans',
  'loans.list.intro':
    "These are loans your lenders have reported to us. Amounts are the lender's own figures, shown as the lender reported them.",
  'loans.list.empty':
    'There are no loans to show yet. A loan appears here once a lender shares it with this app.',
  'loans.open': 'Open loan with {lender}',
  'loans.messages': 'Messages from your lenders',
  'loans.messagesUnread': 'Messages from your lenders ({count} unread)',

  // ---- the loan -----------------------------------------------------------------------------------------------------
  'loans.home.title': 'Loan details',
  'loans.home.pay': 'Pay',
  'loans.home.autopay': 'Set up auto-pay',
  'loans.home.schedule': 'Repayment schedule',
  'loans.home.activity': 'Account activity',
  'loans.home.statements': 'Statements and documents',
  'loans.home.quote': 'Foreclosure quotation',
  'loans.home.closure': 'Closure and no-dues letter',
  'loans.home.refresh': 'Check again',
  'loans.card.reference': 'Loan reference: {ref}',
  'loans.card.nextDue': 'Next due date: {date}',
  'loans.card.nextDueNone': 'Next due date: not reported by {lender}',
  'loans.card.nextDueAmount': 'Next due amount: {amount}',
  'loans.status.label': 'Loan status (per {lender})',
  'loans.status.reportedBy': 'Latest report from {lender} says',
  'loans.status.active': 'Active',
  'loans.status.closed': 'Closed',
  'loans.status.foreclosed': 'Foreclosed',
  'loans.status.written_off': 'Written off',
  'loans.status.cancelled': 'Cancelled',
  'loans.status.unknown': 'Not available in this version of the app',
  'loans.status.writtenOffNote':
    "This is {lender}'s own status for the loan. Ask {lender} what it means for you.",
  'loans.fact.sanctioned': 'Sanctioned amount (per {lender}): {amount}',
  'loans.fact.disbursed': 'Disbursed amount (per {lender}): {amount}',

  // ---- figures reported by the lender -----------------------------------------------------------------------------
  'loans.fig.asReported': 'As reported by {lender} on {date}',
  'loans.fig.stale':
    'The last report from {lender} is from {date}. It may be out of date. Please check again later, or ask {lender} for current figures.',
  'loans.fig.withheld':
    '{lender} is checking these figures. No amounts are shown for now. Please check again later, or ask {lender}.',
  'loans.fig.notReported': 'Not reported by {lender}',
  'loans.fig.outstanding': 'Outstanding principal',
  'loans.fig.nextDueOn': 'Next due date',
  'loans.fig.nextDueAmount': 'Next due amount',
  'loans.fig.overdueTitle': 'Overdue, as reported by {lender}',
  'loans.fig.overduePrincipal': 'Overdue principal',
  'loans.fig.overdueInterest': 'Overdue interest',
  'loans.fig.totalOverdue': 'Total overdue, as stated by the lender',
  'loans.fig.daysPastDue': 'Days past due, as reported',
  'loans.fig.overdueNote':
    "These are the lender's own figures. Nothing here has been added up or changed by this app.",

  // ---- schedule -----------------------------------------------------------------------------------------------------
  'loans.schedule.title': 'Repayment schedule',
  'loans.schedule.asReported': 'Schedule as reported by {lender} on {date}',
  'loans.schedule.none':
    'There is no schedule to show. {lender} has not reported one, or it is being checked.',
  'loans.schedule.note':
    "This is {lender}'s schedule. It does not show the state of any instalment. Account activity shows what has been reported.",
  'loans.schedule.row': 'Instalment {seq}, due {date}',
  'loans.schedule.principal': 'Principal: {amount}',
  'loans.schedule.interest': 'Interest: {amount}',
  'loans.schedule.fees': 'Fees: {amount}',
  'loans.schedule.total': 'Total: {amount}',

  // ---- activity -----------------------------------------------------------------------------------------------------
  'loans.activity.title': 'Account activity',
  'loans.activity.note':
    'Built from what {lender} and the payment provider have reported. This is not a statement of account. Entries are listed in the order they reached us.',
  'loans.activity.empty': 'There is no activity to show yet.',
  'loans.activity.more': 'Load more',
  'loans.activity.details': 'See payment details',
  'loans.activity.date': 'Date: {date}',
  'loans.activity.amount': 'Amount: {amount}',
  'loans.activity.amountNone': 'Amount: not reported',
  'loans.activity.kind.lender_receipt': 'Receipt from {lender}',
  'loans.activity.kind.lender_reversal': 'Reversal recorded by {lender}',
  'loans.activity.kind.payment_attempt': 'Payment attempt',
  'loans.activity.kind.payment_adjustment': 'Adjustment reported by the payment provider',
  'loans.activity.kind.unknown': 'Entry not available in this version of the app',
  'loans.purpose.installment': 'For an instalment',
  'loans.purpose.overdue': 'For the overdue amount',
  'loans.purpose.part_prepayment': 'For a part-prepayment',
  'loans.purpose.foreclosure': 'For foreclosure',
  'loans.purpose.charges': 'For charges',
  'loans.state.started': 'Started. Nothing has been confirmed yet.',
  'loans.state.provider_received':
    'Received by the payment provider. This does not yet mean that {lender} has posted it to your loan.',
  'loans.state.lender_posted': '{lender} has posted it to your loan.',
  'loans.state.needs_attention': 'Needs attention: contact {lender}.',
  'loans.state.cancelled': 'Cancelled.',
  'loans.state.failed': 'Failed.',
  'loans.state.expired': 'Expired.',
  'loans.state.posted': 'Posted to your loan by {lender}.',
  'loans.state.reversed': 'Posted by {lender} and later reversed.',
  'loans.state.recorded': 'Recorded by {lender}.',
  'loans.state.refund': 'A refund was reported.',
  'loans.state.chargeback': 'A chargeback was reported.',
  'loans.state.reversal': 'A reversal was reported.',
  'loans.state.correction': 'A correction was reported.',
  'loans.state.unknown': 'This status is not available in this version of the app. Ask {lender}.',

  // ---- statements, documents and requests -------------------------------------------------------------------------
  'loans.stmt.title': 'Statements and documents',
  'loans.stmt.intro':
    '{lender} issues statements and letters. This app does not make them. You can ask {lender} for a statement here.',
  'loans.stmt.requestTitle': 'Ask for a statement of account',
  'loans.stmt.periodNote':
    'Leave both dates empty to ask for the whole history of the loan. Or give a period: both dates, written as year-month-day.',
  'loans.stmt.from': 'From date (YYYY-MM-DD)',
  'loans.stmt.to': 'To date (YYYY-MM-DD)',
  'loans.stmt.dateExample': 'For example 2026-04-01',
  'loans.stmt.errIncomplete': 'Enter both dates, or leave both empty.',
  'loans.stmt.errInvalid': 'Enter real dates, written as YYYY-MM-DD.',
  'loans.stmt.submit': 'Ask {lender} for a statement',
  'loans.stmt.submitting': 'Sending…',
  'loans.stmt.sent':
    'Your request was sent to {lender}. It appears in your requests below until {lender} answers.',
  'loans.stmt.requestsTitle': 'Your requests',
  'loans.stmt.requestsEmpty': 'You have no requests for this loan.',
  'loans.stmt.cancel': 'Cancel this request',
  'loans.stmt.cancelling': 'Cancelling…',
  'loans.stmt.cancelled': 'Your request was cancelled.',
  'loans.stmt.openDocument': 'Open the document',
  'loans.stmt.viewQuote': 'See the quotation',
  'loans.stmt.docsTitle': 'Documents from {lender}',
  'loans.stmt.docsEmpty': 'There are no documents yet.',
  'loans.req.status.requested': 'Requested. {lender} has not answered yet.',
  'loans.req.status.fulfilled': '{lender} has provided this.',
  'loans.req.status.declined': '{lender} has declined this request.',
  'loans.req.status.expired': 'This request has expired.',
  'loans.req.status.cancelled': 'This request was cancelled.',
  'loans.req.requestedOn': 'Requested on {date}',
  'loans.req.lenderNote': 'Note from {lender}',
  'loans.due.target': 'Target date: {date}',
  'loans.due.default':
    'This is a platform default. It is not a legal or regulatory deadline, and not a promise by {lender}.',
  'loans.doc.kind.statement': 'Statement of account',
  'loans.doc.kind.foreclosure_quote': 'Foreclosure quotation letter',
  'loans.doc.kind.noc': 'No-dues letter (NOC)',
  'loans.doc.kind.closure_letter': 'Closure letter',
  'loans.doc.kind.unknown': 'Document',
  'loans.doc.reference': 'Reference given by the lender: {ref}',
  'loans.doc.issued': 'Issued by {lender} on {date}',
  'loans.doc.period': 'Period: {from} to {to}',
  'loans.doc.mock': 'Test document. It is not a real document.',
  'loans.doc.superseded': '{lender} has replaced this with a newer document.',
  'loans.doc.open': 'Open this document',
  'loans.doc.opening': 'Opening…',
  'loans.doc.noViewer':
    'This device has no app that can show the file. Install a PDF viewer and try again.',
  'loans.doc.openFailed': 'The file could not be opened.',
  'loans.doc.checkFailed': 'The file did not match what was recorded, so it was not opened.',

  // ---- foreclosure quotation ----------------------------------------------------------------------------------------
  'loans.quote.title': 'Foreclosure quotation',
  'loans.quote.intro':
    'A foreclosure quotation is the amount {lender} quotes to close this loan early. {lender} works it out. This app only shows it.',
  'loans.quote.none': '{lender} has not given you a valid quotation yet.',
  'loans.quote.request': 'Ask {lender} for a quotation',
  'loans.quote.requestCorrected': 'Ask {lender} for a corrected quotation',
  'loans.quote.requesting': 'Sending…',
  'loans.quote.sent': 'Your request was sent to {lender}.',
  'loans.quote.attribution': 'Quotation from {lender}, reference {ref}',
  'loans.quote.asOf': 'As of {date}',
  'loans.quote.validUntil': 'Valid until {date}',
  'loans.quote.principal': 'Principal',
  'loans.quote.interest': 'Interest',
  'loans.quote.charges': 'Charges',
  'loans.quote.prepayment': 'Prepayment charge',
  'loans.quote.total': 'Total quoted by {lender}',
  'loans.quote.mismatch':
    'The parts of this quotation do not add up to its total. Ask {lender} for a corrected quotation. Payment is not offered for this quotation.',
  'loans.quote.pay': 'Pay this quotation',
  'loans.quote.letter': 'Open the quotation letter',

  // ---- closure --------------------------------------------------------------------------------------------------------
  'loans.closure.title': 'Closure and no-dues letter',
  'loans.closure.none': '{lender} has not reported this loan as closed.',
  'loans.closure.kind.closed': '{lender} has reported this loan as closed.',
  'loans.closure.kind.foreclosed': '{lender} has reported this loan as foreclosed.',
  'loans.closure.recorded':
    'Recorded in this app on {date}. This is not necessarily the date the lender closed the loan.',
  'loans.closure.noc.heading': 'No-dues letter (NOC)',
  'loans.closure.noc.pending':
    '{lender} has not yet reported that it issued the no-dues letter (NOC).',
  'loans.closure.noc.issued': '{lender} has reported that it issued the no-dues letter (NOC).',
  'loans.closure.noc.open': 'Open the no-dues letter',
  'loans.closure.issuedOn': 'Issued on {date}, as reported by the lender.',
  'loans.closure.sec.heading': 'Security held for this loan',
  'loans.closure.sec.mutual_fund_lien.pending':
    '{lender} is to release the lien on your mutual fund units. {lender} has not yet confirmed that it has done so.',
  'loans.closure.sec.mutual_fund_lien.confirmed':
    '{lender} has confirmed that it released the lien on your mutual fund units.',
  'loans.closure.sec.demat_pledge.pending':
    '{lender} is to release the pledge on your securities. {lender} has not yet confirmed that it has done so.',
  'loans.closure.sec.demat_pledge.confirmed':
    '{lender} has confirmed that it released the pledge on your securities.',
  'loans.closure.sec.property_documents.pending':
    '{lender} is to return your property documents. {lender} has not yet confirmed that it has done so.',
  'loans.closure.sec.property_documents.confirmed':
    '{lender} has confirmed that it returned your property documents.',
  'loans.closure.sec.vehicle_hypothecation.pending':
    '{lender} is to release the hypothecation on your vehicle. {lender} has not yet confirmed that it has done so.',
  'loans.closure.sec.vehicle_hypothecation.confirmed':
    '{lender} has confirmed that it released the hypothecation on your vehicle.',
  'loans.closure.sec.other.pending':
    '{lender} is to release the security it holds for this loan. {lender} has not yet confirmed that it has done so.',
  'loans.closure.sec.other.confirmed':
    '{lender} has confirmed that it released the security it held for this loan.',
  'loans.closure.unknown': 'Ask {lender} about the status of this item.',
  'loans.closure.delay': 'Reason given by {lender} for a delay',
  'loans.closure.confirmedOn': 'Confirmed on {date}, as reported by the lender.',
  'loans.closure.footer':
    'The status of each item comes from {lender}. This app does not hold or release any security and does not issue any letter.',

  // ---- errors of these screens --------------------------------------------------------------------------------------
  'loans.err.notFound':
    'We could not find that. It may have been removed, or your lender may no longer share it here.',
  'loans.err.featureDisabled': 'This is not available for this lender right now.',
  'loans.err.statusNotEligible': 'A statement cannot be requested for this loan right now.',
  'loans.err.loanNotActive': 'A foreclosure quotation can be requested only for an active loan.',
  'loans.err.openRequestExists':
    'You already have an open request of this kind. It is listed here.',
  'loans.err.conflict':
    'This request clashes with an earlier one. Please check your requests and try again.',
  'loans.err.periodInvalid':
    'Please check the dates. The period cannot end before it starts or reach into the future.',
  'loans.err.requestNotOpen': 'This request is no longer open, so it cannot be cancelled.',
  'loans.err.cursor': 'The list could not be continued. Please start again.',
  'loans.err.documentsUnavailable': 'Documents cannot be opened right now. Please try again later.',
  'loans.err.noAccess': 'This account does not have access to loan information.',

  // ---- messages from lenders (reminders) ----------------------------------------------------------------------------
  'reminders.title': 'Messages from your lenders',
  'reminders.intro':
    'These are messages your lenders asked us to show you. They are shown exactly as the lender worded them.',
  'reminders.empty': 'You have no messages.',
  'reminders.unread': 'New',
  'reminders.open': 'Read this message',
  'reminders.hide': 'Hide this message',
  'reminders.from': 'From {lender}',
  'reminders.fromUnknown': 'From a lender',
  'reminders.kind.pre_due': 'Reminder before the due date',
  'reminders.kind.due_day': 'Reminder on the due date',
  'reminders.kind.overdue': 'Reminder about an overdue amount',
  'reminders.kind.unknown': 'Message from a lender',
  'reminders.dueOn': 'Due date: {date}',
  'reminders.sentOn': 'Sent on {date}',
  'reminders.goToLoan': 'Go to this loan',
} as const;
