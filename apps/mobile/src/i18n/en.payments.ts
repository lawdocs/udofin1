/**
 * English text for payments and mandates (keys `pay.*` and `mandate.*`), Phase 08a.
 *
 * Wording rules: plain, calm, factual; no urgency, countdowns or offers. Say whose figure it is. "Received by the payment provider"
 * is never "paid to the lender". A mandate is "requested", "waiting for your bank" or "active" only as the provider-confirmed status
 * says, and a cancellation is a request until the status changes. Nothing here claims compliance, approval or safety.
 */
export const enPayments = {
  // ---- paying: options ----
  'pay.title': 'Make a payment',
  'pay.intro':
    "You choose what to pay and confirm it here. You then pay on the payment provider's page, not in this app. {lender} sets the amounts.",
  'pay.lender': 'Lender: {lender}',
  'pay.destination': "Paid to {lender}'s account {account}",
  'pay.reportedAsOf': 'As reported by {lender} on {date}',
  'pay.stale':
    'These figures are out of date. {lender} last reported them on {date}. Payments that depend on them cannot be started until {lender} reports again.',
  'pay.staleNoDate':
    'These figures are out of date. Payments that depend on them cannot be started until {lender} reports again.',
  'pay.withheld':
    '{lender} is checking these figures. No amount is shown until {lender} has confirmed them.',
  'pay.unavailable.loan_not_active':
    'Payments cannot be started in the app because this loan is not active. Please contact {lender} if you have questions.',
  'pay.unavailable.collection_target_invalid':
    'We could not confirm where {lender} receives payments, so payments are not offered in the app right now. Please contact {lender}.',
  'pay.unavailable.config_ambiguous':
    'The payment set-up for {lender} needs to be checked before payments can be offered in the app. Please contact {lender}.',
  'pay.unavailable.unknown': 'Payments cannot be started in the app right now.',
  'pay.noneOffered':
    'No payment can be started in the app right now. {lender} decides which payments the app offers.',
  'pay.open.title': 'Payments in progress',
  'pay.open.note':
    'You already have a payment in progress on this loan. Open it to see where it stands.',
  'pay.open.item': '{purpose}: {status}',
  'pay.open.view': 'View payment: {purpose}',
  'pay.choose': 'What would you like to pay?',
  'pay.chooseNote': 'Nothing is selected for you. Choose one option.',
  'pay.purpose.installment': 'Next instalment',
  'pay.purpose.overdue': 'Overdue amount',
  'pay.purpose.part_prepayment': 'Part-prepayment',
  'pay.purpose.foreclosure': 'Foreclosure (paying off the loan)',
  'pay.purpose.charges': 'Charges',
  'pay.purpose.unknown': 'Payment',
  'pay.source.reported': 'Amount set by {lender}: ₹{amount}',
  'pay.source.quote': "Amount set by {lender}'s quotation: ₹{amount}",
  'pay.source.limits': 'You choose the amount, within limits set by {lender}: ₹{min} to ₹{max}',
  'pay.due': 'Due on {date}',
  'pay.partial':
    'A smaller amount is also accepted, within limits set by {lender}: ₹{min} to ₹{max}.',
  'pay.quote.validUntil': 'The quotation is valid until {date}.',
  'pay.quote.flagged':
    "{lender}'s quotation does not add up, so it cannot be paid in the app until {lender} corrects it.",
  'pay.penal.label': 'From {lender}',
  'pay.mode.reported': 'Pay ₹{amount}, the amount set by {lender}',
  'pay.mode.other': 'Pay another amount, within limits set by {lender}',
  'pay.amountLabel': 'Amount in rupees',
  'pay.amountHint': 'Between ₹{min} and ₹{max}',
  'pay.amount.invalid': 'Enter an amount in rupees, for example 5,000 or 5000.50.',
  'pay.amount.tooLow': 'The amount must be at least ₹{min}.',
  'pay.amount.tooHigh': 'The amount must be at most ₹{max}.',
  'pay.summary.title': 'Check before you start',
  'pay.summary.line': 'You are about to start a payment of ₹{amount} ({purpose}) to {lender}.',
  'pay.summary.next':
    "The next screen shows where the payment stands. You then pay on the payment provider's page.",
  'pay.start': 'Start this payment',
  'pay.starting': 'Starting…',
  'pay.chooseFirst': 'Choose what to pay to continue.',
  'pay.refresh': 'Check again',
  'pay.refreshFailed': 'We could not refresh just now. What you see may be out of date.',

  // ---- paying: errors (stable API codes only; never server text) ----
  'pay.err.conflict':
    'This request clashes with an earlier one that had different details. Please go back and start again.',
  'pay.err.amountNotAllowed':
    'This amount is not allowed. Please check the limits shown and try again.',
  'pay.err.featureOff': 'This is not available for this lender right now.',
  'pay.err.loanNotActive': 'This loan is not active, so a payment cannot be started.',
  'pay.err.targetInvalid':
    'Payments to this lender cannot be started in the app right now. Please contact the lender.',
  'pay.err.figuresUnavailable':
    "The lender's figures are not available right now, so this payment cannot be started. Please check again later.",
  'pay.err.stale':
    "The lender's figures are out of date, so this payment cannot be started until the lender reports again.",
  'pay.err.nothingDue': 'The lender has not reported an amount due for this payment.',
  'pay.err.purposeOff': 'This kind of payment is not available in the app for this loan.',
  'pay.err.quoteRequired': 'A current quotation from the lender is needed for this payment.',
  'pay.err.quoteNotCurrent':
    "The lender's quotation is no longer current. The latest options are shown on the screen.",
  'pay.err.quoteFlagged':
    "The lender's quotation does not add up, so it cannot be paid until the lender corrects it.",
  'pay.err.openExists':
    'You already have a payment in progress for this. Open it to see where it stands.',
  'pay.err.blocked': 'Payments cannot be started in this version of the app.',
  'pay.err.notCancellable':
    'This payment can no longer be cancelled because a payment page already exists.',
  'pay.err.handoffUnavailable': 'The provider page cannot be opened in this version of the app.',

  // ---- payment status ----
  'pay.status.title': 'Payment',
  'pay.status.created': 'Started',
  'pay.status.pending': 'Started, with the payment provider',
  'pay.status.succeeded': 'Reported by the payment provider',
  'pay.status.failed': 'Did not complete',
  'pay.status.expired': 'Expired',
  'pay.status.cancelled': 'Cancelled',
  'pay.status.unknown': 'Not available',
  'pay.stage.started': 'Payment started',
  'pay.stage.provider_received': 'Received by the payment provider',
  'pay.stage.lender_posted': '{lender} has posted it to your loan',
  'pay.stage.needs_attention': 'Needs attention: contact {lender}',
  'pay.stage.cancelled': 'Payment cancelled',
  'pay.stage.failed': 'Payment did not complete',
  'pay.stage.expired': 'Payment expired',
  'pay.stage.unknown': "This payment's stage cannot be shown. Contact {lender} if you need help.",
  'pay.explain.started':
    'Nothing has been reported as received yet. This screen changes only when the payment provider or {lender} reports something.',
  'pay.explain.provider_received':
    '"Received" means the payment provider has reported your payment. It does not yet mean {lender} has posted it to your loan. {lender} decides that in its own records.',
  'pay.explain.lender_posted':
    "{lender}'s own record shows this payment. How it is applied to your loan is {lender}'s decision.",
  'pay.explain.needs_attention':
    'Something about this payment needs checking, for example an amount that differs. Please contact {lender} and mention the date and the amount.',
  'pay.explain.cancelled': 'This payment was cancelled. No payment page will open for it.',
  'pay.explain.failed':
    'The payment provider has not reported receiving money for this payment. If money left your account, please contact {lender}.',
  'pay.explain.expired':
    'The payment page expired and the payment provider has not reported receiving money for it. If money left your account, please contact {lender}.',
  'pay.detail.amount': 'Amount: ₹{amount}',
  'pay.detail.purpose': 'For: {purpose}',
  'pay.detail.started': 'Started on {date}',
  'pay.detail.providerAt': 'Reported by the payment provider on {date}',
  'pay.detail.postedOn': 'Posted by {lender} with value date {date}',
  'pay.wait.order':
    'The payment page is being prepared. This can take a short while. You can leave this screen and come back.',
  'pay.wait.afterReturn':
    'Coming back from the payment page does not show whether a payment was made. We are checking what the payment provider and {lender} report.',
  'pay.wait.stopped': 'We stopped checking automatically. Use "Check again" to see the latest.',
  'pay.link.button': 'Continue to the payment page',
  'pay.link.note':
    'The payment page opens in your browser. The payment provider runs it. You pay there, not in this app.',
  'pay.link.until': 'The page can be opened until {date}.',
  'pay.link.opening': 'Opening…',
  'pay.link.failed': 'The payment page could not be opened. Please try again.',
  'pay.link.unavailable':
    'The payment page is not available right now. Use "Check again" to see the latest.',
  'pay.link.none': 'There is no payment page to open right now.',
  'pay.cancel.button': 'Cancel this payment',
  'pay.cancel.note': 'You can cancel only while the payment page has not been prepared.',
  'pay.cancel.busy': 'Cancelling…',
  'pay.again': 'Back to payment options',

  // ---- mandates: list and setup ----
  'mandate.title': 'Auto-pay',
  'mandate.list.title': 'Your auto-pay mandates',
  'mandate.list.intro':
    'An auto-pay mandate is an instruction to your bank that lets your lender ask for loan payments to be debited. You can ask to cancel it here.',
  'mandate.list.empty': 'You do not have an auto-pay mandate.',
  'mandate.open': 'Open: {lender}',
  'mandate.setup.title': 'Set up auto-pay',
  'mandate.setup.intro':
    'Auto-pay is an instruction to your bank. Once your bank and the provider confirm it, {lender} can ask your bank for debits from your account, up to the limit shown below. It is set up only when the provider confirms it.',
  'mandate.setup.requirement.optional': '{lender} lists auto-pay as optional.',
  'mandate.setup.requirement.before_first_due':
    "{lender} asks for auto-pay to be set up before the first due date. This is {lender}'s setting.",
  'mandate.setup.lead':
    'The notice before a debit is set to {hours} hours ahead. This is a setting, not a guarantee that a notice will arrive.',
  'mandate.setup.existing': 'You already have an auto-pay mandate for this loan.',
  'mandate.setup.viewExisting': 'View it',
  'mandate.setup.rails': 'Choose how to set it up',
  'mandate.setup.railsNote': 'Nothing is selected for you. Choose one option.',
  'mandate.unavailable.loan_not_active':
    'Auto-pay cannot be set up because this loan is not active. Please contact {lender} if you have questions.',
  'mandate.unavailable.collection_target_invalid':
    'We could not confirm where {lender} receives payments, so auto-pay is not offered in the app right now. Please contact {lender}.',
  'mandate.unavailable.config_ambiguous':
    'The payment set-up for {lender} needs to be checked before auto-pay can be offered. Please contact {lender}.',
  'mandate.unavailable.provider_not_mandate_capable':
    "Auto-pay is not available with {lender}'s payment provider.",
  'mandate.unavailable.rail_not_configured':
    'No way of setting up auto-pay has been made available by {lender} yet.',
  'mandate.unavailable.mandate_exists': 'You already have an auto-pay mandate for this loan.',
  'mandate.unavailable.unknown': 'Auto-pay cannot be set up in the app right now.',
  'mandate.rail.enach_api': 'eNACH (net banking or debit card)',
  'mandate.rail.upi_autopay': 'UPI AutoPay',
  'mandate.rail.unknown': 'Auto-pay',
  'mandate.rail.effect.enach_api':
    'You authorise it on a page run by your bank or the provider, using net banking or a debit card. After the provider confirms it, {lender} can ask your bank for debits up to the limit.',
  'mandate.rail.effect.upi_autopay':
    'You authorise it through UPI. After the provider confirms it, {lender} can ask for debits through UPI up to the limit.',
  'mandate.rail.effect.unknown':
    'After the provider confirms it, {lender} can ask for debits up to the limit.',
  'mandate.rail.max': 'Highest amount for one debit: ₹{amount}',
  'mandate.rail.maxNote':
    'This is the lower of the limit of this method and the ceiling set by {lender}.',
  'mandate.rail.afa': 'Your bank may ask you to approve every debit with a prompt.',
  'mandate.start': 'Start date',
  'mandate.end': 'End date',
  'mandate.dateHint': 'DD/MM/YYYY',
  'mandate.date.invalid': 'Enter a real date as DD/MM/YYYY.',
  'mandate.dates.note': 'The start and end dates are checked when you send the request.',
  'mandate.account.label': 'Last 4 digits of your bank account number',
  'mandate.account.hint': 'Enter only the last 4 digits. Never enter the full account number.',
  'mandate.account.invalid': 'Enter exactly 4 digits.',
  'mandate.account.preview': 'Your account will be shown as {account}.',
  'mandate.step.title': 'Step 1: confirm with a one-time code',
  'mandate.step.note':
    'The code is tied to this request. If you start again later, you will need a new code.',
  'mandate.step.button': 'Get and enter a one-time code',
  'mandate.send.title': 'Step 2: send the request',
  'mandate.summary':
    'Request: {rail}, up to ₹{amount} for one debit, from {start} to {end}, bank account {account}.',
  'mandate.create': 'Send the auto-pay request',
  'mandate.creating': 'Sending…',
  'mandate.chooseRail': 'Choose how to set it up first.',

  // ---- mandates: errors ----
  'mandate.err.stepup':
    'A one-time code check is needed for this request. Confirm with a code in step 1, then send the request again.',
  'mandate.err.integrity':
    'This device did not pass the security check needed to set up auto-pay, so the request was not accepted.',
  'mandate.err.providerNotCapable':
    "Auto-pay is not available with this lender's payment provider.",
  'mandate.err.creditor':
    'Auto-pay cannot be set up for this lender right now. Please contact the lender.',
  'mandate.err.rail': 'This way of setting up auto-pay is not available for this lender.',
  'mandate.err.exists': 'You already have an auto-pay mandate for this loan.',
  'mandate.err.dates': 'Please check the start and end dates and try again.',
  'mandate.err.account': 'Enter only the last 4 digits of the account number.',
  'mandate.err.finished': 'This auto-pay is already finished, so it cannot be cancelled.',

  // ---- mandates: detail ----
  'mandate.detail.title': 'Auto-pay mandate',
  'mandate.lender': 'Lender: {lender}',
  'mandate.account': 'Bank account: {account}',
  'mandate.max': 'Highest amount for one debit: ₹{amount}',
  'mandate.period': 'From {start} to {end}',
  'mandate.status.draft': 'Requested',
  'mandate.status.registration_pending': 'Waiting for your bank',
  'mandate.status.active': 'Active',
  'mandate.status.paused': 'Paused',
  'mandate.status.rejected': 'Rejected',
  'mandate.status.failed': 'Did not complete',
  'mandate.status.expired': 'Expired',
  'mandate.status.cancelled': 'Cancelled',
  'mandate.status.revoked': 'Revoked',
  'mandate.status.requires_reconciliation': 'Being checked',
  'mandate.status.unknown': 'Status not available',
  'mandate.explain.draft':
    'Your request was received. We are asking the provider to prepare the authorisation page. Nothing is set up yet.',
  'mandate.explain.registration_pending':
    'Waiting for your bank. Open the authorisation page to continue. The auto-pay is set up only when the provider confirms it.',
  'mandate.explain.active': 'Active, as confirmed by the provider.',
  'mandate.explain.paused': 'Paused, as reported by the provider.',
  'mandate.explain.rejected': 'The bank or the provider did not accept this request.',
  'mandate.explain.failed': 'The set-up did not complete.',
  'mandate.explain.expired': 'This auto-pay has expired, as reported by the provider.',
  'mandate.explain.cancelled': 'Cancelled, as confirmed by the provider.',
  'mandate.explain.revoked':
    'This auto-pay was withdrawn at the bank, as reported by the provider.',
  'mandate.explain.requires_reconciliation':
    "The provider's outcome is not known yet. We are checking with the provider and {lender}.",
  'mandate.explain.unknown': 'Contact {lender} if you need help.',
  'mandate.cancelRequested':
    'Cancellation requested. This is a request until the provider confirms it. The status above has not changed.',
  'mandate.cancel.button': 'Request cancellation',
  'mandate.cancel.confirmTitle': 'Ask to cancel this auto-pay?',
  'mandate.cancel.confirmBody':
    'This sends a cancellation request to the provider. It is only a request: the auto-pay stays as it is until the provider confirms.',
  'mandate.cancel.send': 'Send the cancellation request',
  'mandate.cancel.keep': 'Keep it as it is',
  'mandate.cancel.busy': 'Sending…',
  'mandate.next.title': 'Next planned debit',
  'mandate.next.line': 'On {date}: ₹{amount}',
  'mandate.next.noAmount': '{date}: amount not reported yet',
  'mandate.next.none': 'No planned debit is reported.',
  'mandate.next.noticeSent': 'A notice for this debit has been sent.',
  'mandate.next.noticeNot': 'A notice for this debit has not been sent yet.',
  'mandate.next.note':
    "Planned debits come from {lender}'s reported schedule. This is not a promise that a debit will or will not be made.",
  'mandate.debits.title': 'Debits',
  'mandate.debits.empty': 'No debits are reported for this auto-pay.',
  'mandate.debit.planned': 'Planned',
  'mandate.debit.reported': 'Reported by the provider',
  'mandate.debit.amount': 'Amount: ₹{amount}',
  'mandate.debit.noAmount': 'Amount not reported',
  'mandate.debit.status.scheduled': 'Scheduled',
  'mandate.debit.status.notified': 'Notice sent',
  'mandate.debit.status.presented': 'Sent to your bank',
  'mandate.debit.status.unknown': 'Outcome not known yet',
  'mandate.debit.status.settled': 'Reported as settled',
  'mandate.debit.status.returned': 'Returned',
  'mandate.debit.status.cancelled': 'Cancelled',
  'mandate.debit.status.other': 'Status not available',
  'mandate.debit.noClass': 'No reason has been classified.',
  'mandate.debit.class.insufficient_funds': 'Reason class: insufficient funds',
  'mandate.debit.class.account_issue': 'Reason class: account issue',
  'mandate.debit.class.mandate_issue': 'Reason class: mandate issue',
  'mandate.debit.class.technical': 'Reason class: technical',
  'mandate.debit.class.other': 'Reason class: other',
  'mandate.notice.planned': 'Notice planned for {date}',
  'mandate.notice.sent': 'Notice sent on {date}',
  'mandate.notice.late': 'The notice was late (it was due by {date})',
  'mandate.notice.not_needed': 'No notice needed for this debit',
  'mandate.link.button': 'Continue to authorise',
  'mandate.link.note':
    'The authorisation page opens in your browser. Your bank or the provider runs it. Coming back from it does not by itself show that the auto-pay is active.',
  'mandate.link.opening': 'Opening…',
  'mandate.link.failed': 'The authorisation page could not be opened. Please try again.',
  'mandate.link.unavailable':
    'The authorisation page is not available right now. Use "Check again" to see the latest.',
  'mandate.wait.afterReturn':
    'We are checking what the provider reports. The status changes only when the provider confirms it.',
  'mandate.wait.stopped': 'We stopped checking automatically. Use "Check again" to see the latest.',
} as const;
