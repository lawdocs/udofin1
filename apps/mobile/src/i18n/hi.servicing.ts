import { type enServicing } from './en.servicing';

/**
 * Hindi text for the same keys. DRAFT like the rest of hi.ts: not reviewed by a native speaker or by counsel. It follows the
 * English wording rules: every figure is the lender's, withheld figures are never zero, a payment is "received by the payment
 * provider" before it is "posted by the lender", and nothing is called "paid" or "successful".
 */
export const hiServicing: Record<keyof typeof enServicing, string> = {
  // ---- entry points -----------------------------------------------------------------------------------------------
  'loans.entry': 'मेरे ऋण',
  'loans.entry.note':
    'अपने ऋण वैसे देखें जैसे आपके ऋणदाता बताते हैं, और ऋणदाताओं के भेजे संदेश देखें।',
  'loans.title': 'मेरे ऋण',
  'loans.list.intro':
    'ये वे ऋण हैं जो आपके ऋणदाताओं ने हमें बताए हैं। राशियाँ ऋणदाता की अपनी हैं, ठीक वैसी जैसी ऋणदाता ने बताईं।',
  'loans.list.empty':
    'अभी दिखाने के लिए कोई ऋण नहीं है। कोई ऋणदाता ऋण इस ऐप के साथ साझा करता है तो वह यहाँ दिखता है।',
  'loans.open': '{lender} के साथ ऋण खोलें',
  'loans.messages': 'आपके ऋणदाताओं के संदेश',
  'loans.messagesUnread': 'आपके ऋणदाताओं के संदेश ({count} अपठित)',

  // ---- the loan -----------------------------------------------------------------------------------------------------
  'loans.home.title': 'ऋण का विवरण',
  'loans.home.pay': 'भुगतान करें',
  'loans.home.autopay': 'ऑटो-पे चालू करें',
  'loans.home.schedule': 'किस्तों की सूची',
  'loans.home.activity': 'खाते की गतिविधि',
  'loans.home.statements': 'विवरण और दस्तावेज़',
  'loans.home.quote': 'समय-पूर्व बंदी का कोटेशन',
  'loans.home.closure': 'बंदी और बकाया-नहीं पत्र',
  'loans.home.refresh': 'फिर देखें',
  'loans.card.reference': 'ऋण संदर्भ: {ref}',
  'loans.card.nextDue': 'अगली देय तिथि: {date}',
  'loans.card.nextDueNone': 'अगली देय तिथि: {lender} ने नहीं बताई',
  'loans.card.nextDueAmount': 'अगली देय राशि: {amount}',
  'loans.status.label': 'ऋण की स्थिति',
  'loans.status.reportedBy': '{lender} की ताज़ा रिपोर्ट में लिखा है',
  'loans.status.active': 'चालू',
  'loans.status.closed': 'बंद',
  'loans.status.foreclosed': 'समय से पहले बंद',
  'loans.status.written_off': 'बट्टे खाते में डाला गया',
  'loans.status.cancelled': 'रद्द',
  'loans.status.unknown': 'ऐप के इस संस्करण में उपलब्ध नहीं',
  'loans.status.writtenOffNote':
    'यह ऋण के बारे में {lender} की अपनी स्थिति है। इसका आपके लिए क्या अर्थ है, यह {lender} से पूछें।',
  'loans.fact.sanctioned': 'स्वीकृत राशि: {amount}',
  'loans.fact.disbursed': 'वितरित राशि: {amount}',

  // ---- figures reported by the lender -----------------------------------------------------------------------------
  'loans.fig.asReported': '{lender} द्वारा {date} को बताया गया',
  'loans.fig.stale':
    '{lender} की ताज़ा रिपोर्ट {date} की है। यह पुरानी हो सकती है। कृपया बाद में फिर देखें, या {lender} से ताज़ा आँकड़े पूछें।',
  'loans.fig.withheld':
    '{lender} इन आँकड़ों की जाँच कर रहा है। फ़िलहाल कोई राशि नहीं दिखाई जा रही। कृपया बाद में फिर देखें, या {lender} से पूछें।',
  'loans.fig.notReported': '{lender} ने नहीं बताया',
  'loans.fig.outstanding': 'बकाया मूलधन',
  'loans.fig.nextDueOn': 'अगली देय तिथि',
  'loans.fig.nextDueAmount': 'अगली देय राशि',
  'loans.fig.overdueTitle': '{lender} द्वारा बताया गया अतिदेय',
  'loans.fig.overduePrincipal': 'अतिदेय मूलधन',
  'loans.fig.overdueInterest': 'अतिदेय ब्याज',
  'loans.fig.totalOverdue': 'ऋणदाता द्वारा बताया गया कुल अतिदेय',
  'loans.fig.daysPastDue': 'बताए अनुसार देरी के दिन',
  'loans.fig.overdueNote': 'ये ऋणदाता के अपने आँकड़े हैं। इस ऐप ने यहाँ कुछ जोड़ा या बदला नहीं है।',

  // ---- schedule -----------------------------------------------------------------------------------------------------
  'loans.schedule.title': 'किस्तों की सूची',
  'loans.schedule.asReported': '{lender} द्वारा {date} को बताई गई सूची',
  'loans.schedule.none':
    'दिखाने के लिए कोई सूची नहीं है। {lender} ने सूची नहीं बताई है, या उसकी जाँच हो रही है।',
  'loans.schedule.note':
    'यह {lender} की सूची है। इसमें यह नहीं बताया गया कि कौन-सी किस्तें चुकाई जा चुकी हैं। जो बताया गया है वह खाते की गतिविधि में दिखता है।',
  'loans.schedule.row': 'किस्त {seq}, देय {date}',
  'loans.schedule.principal': 'मूलधन: {amount}',
  'loans.schedule.interest': 'ब्याज: {amount}',
  'loans.schedule.fees': 'शुल्क: {amount}',
  'loans.schedule.total': 'कुल: {amount}',

  // ---- activity -----------------------------------------------------------------------------------------------------
  'loans.activity.title': 'खाते की गतिविधि',
  'loans.activity.note':
    'यह उस जानकारी से बना है जो {lender} और भुगतान प्रदाता ने बताई। यह खाते का विवरण नहीं है। प्रविष्टियाँ उसी क्रम में हैं जिसमें वे हम तक पहुँचीं।',
  'loans.activity.empty': 'अभी दिखाने के लिए कोई गतिविधि नहीं है।',
  'loans.activity.more': 'और दिखाएँ',
  'loans.activity.details': 'भुगतान का विवरण देखें',
  'loans.activity.date': 'तिथि: {date}',
  'loans.activity.amount': 'राशि: {amount}',
  'loans.activity.amountNone': 'राशि: नहीं बताई गई',
  'loans.activity.kind.lender_receipt': '{lender} की रसीद',
  'loans.activity.kind.lender_reversal': '{lender} द्वारा दर्ज उलटाव',
  'loans.activity.kind.payment_attempt': 'भुगतान का प्रयास',
  'loans.activity.kind.payment_adjustment': 'भुगतान प्रदाता द्वारा बताया गया समायोजन',
  'loans.activity.kind.unknown': 'ऐप के इस संस्करण में यह प्रविष्टि उपलब्ध नहीं',
  'loans.purpose.installment': 'किस्त के लिए',
  'loans.purpose.overdue': 'अतिदेय राशि के लिए',
  'loans.purpose.part_prepayment': 'आंशिक अग्रिम भुगतान के लिए',
  'loans.purpose.foreclosure': 'समय-पूर्व बंदी के लिए',
  'loans.purpose.charges': 'शुल्कों के लिए',
  'loans.state.started': 'शुरू हुआ। अभी कुछ भी पुष्ट नहीं हुआ है।',
  'loans.state.provider_received':
    'भुगतान प्रदाता को मिला। इसका अभी यह अर्थ नहीं कि {lender} ने इसे आपके ऋण में दर्ज कर लिया है।',
  'loans.state.lender_posted': '{lender} ने इसे आपके ऋण में दर्ज कर लिया है।',
  'loans.state.needs_attention': 'ध्यान चाहिए: {lender} से संपर्क करें।',
  'loans.state.cancelled': 'रद्द किया गया।',
  'loans.state.failed': 'विफल रहा।',
  'loans.state.expired': 'समय समाप्त हो गया।',
  'loans.state.posted': '{lender} ने आपके ऋण में दर्ज किया।',
  'loans.state.reversed': '{lender} ने दर्ज किया और बाद में उलट दिया।',
  'loans.state.recorded': '{lender} ने दर्ज किया।',
  'loans.state.refund': 'वापसी (रिफ़ंड) की सूचना मिली।',
  'loans.state.chargeback': 'चार्जबैक की सूचना मिली।',
  'loans.state.reversal': 'उलटाव की सूचना मिली।',
  'loans.state.correction': 'सुधार की सूचना मिली।',
  'loans.state.unknown': 'यह स्थिति ऐप के इस संस्करण में उपलब्ध नहीं। {lender} से पूछें।',

  // ---- statements, documents and requests -------------------------------------------------------------------------
  'loans.stmt.title': 'विवरण और दस्तावेज़',
  'loans.stmt.intro':
    '{lender} विवरण और पत्र जारी करता है। यह ऐप उन्हें नहीं बनाता। आप यहाँ से {lender} से विवरण माँग सकते हैं।',
  'loans.stmt.requestTitle': 'खाते का विवरण माँगें',
  'loans.stmt.periodNote':
    'पूरे ऋण का इतिहास माँगने के लिए दोनों तिथियाँ खाली छोड़ें। या अवधि दें: दोनों तिथियाँ, वर्ष-माह-दिन के रूप में।',
  'loans.stmt.from': 'आरंभ तिथि (YYYY-MM-DD)',
  'loans.stmt.to': 'अंतिम तिथि (YYYY-MM-DD)',
  'loans.stmt.dateExample': 'उदाहरण: 2026-04-01',
  'loans.stmt.errIncomplete': 'दोनों तिथियाँ भरें, या दोनों खाली छोड़ें।',
  'loans.stmt.errInvalid': 'सही तिथियाँ भरें, YYYY-MM-DD के रूप में।',
  'loans.stmt.submit': '{lender} से विवरण माँगें',
  'loans.stmt.submitting': 'भेजा जा रहा है…',
  'loans.stmt.sent':
    'आपका अनुरोध {lender} को भेज दिया गया। {lender} के उत्तर देने तक वह नीचे आपके अनुरोधों में दिखेगा।',
  'loans.stmt.requestsTitle': 'आपके अनुरोध',
  'loans.stmt.requestsEmpty': 'इस ऋण के लिए आपका कोई अनुरोध नहीं है।',
  'loans.stmt.cancel': 'यह अनुरोध रद्द करें',
  'loans.stmt.cancelling': 'रद्द किया जा रहा है…',
  'loans.stmt.cancelled': 'आपका अनुरोध रद्द कर दिया गया।',
  'loans.stmt.openDocument': 'दस्तावेज़ खोलें',
  'loans.stmt.viewQuote': 'कोटेशन देखें',
  'loans.stmt.docsTitle': '{lender} के दस्तावेज़',
  'loans.stmt.docsEmpty': 'अभी कोई दस्तावेज़ नहीं है।',
  'loans.req.status.requested': 'अनुरोध किया गया। {lender} ने अभी उत्तर नहीं दिया है।',
  'loans.req.status.fulfilled': '{lender} ने यह उपलब्ध करा दिया है।',
  'loans.req.status.declined': '{lender} ने यह अनुरोध अस्वीकार कर दिया है।',
  'loans.req.status.expired': 'इस अनुरोध की अवधि समाप्त हो गई है।',
  'loans.req.status.cancelled': 'यह अनुरोध रद्द किया गया था।',
  'loans.req.requestedOn': 'अनुरोध की तिथि: {date}',
  'loans.req.lenderNote': '{lender} का नोट',
  'loans.due.target': 'लक्ष्य तिथि: {date}',
  'loans.due.default':
    'यह प्लेटफ़ॉर्म की डिफ़ॉल्ट तिथि है। यह कानूनी या नियामकीय समय-सीमा नहीं है, और {lender} का वादा भी नहीं है।',
  'loans.doc.kind.statement': 'खाते का विवरण',
  'loans.doc.kind.foreclosure_quote': 'समय-पूर्व बंदी का कोटेशन पत्र',
  'loans.doc.kind.noc': 'बकाया-नहीं पत्र (एनओसी)',
  'loans.doc.kind.closure_letter': 'बंदी पत्र',
  'loans.doc.kind.unknown': 'दस्तावेज़',
  'loans.doc.reference': 'ऋणदाता द्वारा दिया गया संदर्भ: {ref}',
  'loans.doc.issued': '{lender} ने {date} को जारी किया',
  'loans.doc.period': 'अवधि: {from} से {to}',
  'loans.doc.mock': 'परीक्षण दस्तावेज़। यह असली दस्तावेज़ नहीं है।',
  'loans.doc.superseded': '{lender} ने इसे नए दस्तावेज़ से बदल दिया है।',
  'loans.doc.open': 'यह दस्तावेज़ खोलें',
  'loans.doc.opening': 'खोला जा रहा है…',
  'loans.doc.noViewer':
    'इस फ़ोन में फ़ाइल दिखाने वाला कोई ऐप नहीं है। पीडीएफ़ दर्शक ऐप लगाकर फिर कोशिश करें।',
  'loans.doc.openFailed': 'फ़ाइल नहीं खोली जा सकी।',
  'loans.doc.checkFailed': 'फ़ाइल दर्ज जानकारी से मेल नहीं खाई, इसलिए उसे खोला नहीं गया।',

  // ---- foreclosure quotation ----------------------------------------------------------------------------------------
  'loans.quote.title': 'समय-पूर्व बंदी का कोटेशन',
  'loans.quote.intro':
    'समय-पूर्व बंदी का कोटेशन वह राशि है जो {lender} इस ऋण को जल्दी बंद करने के लिए बताता है। इसे {lender} तय करता है। यह ऐप इसे केवल दिखाता है।',
  'loans.quote.none': '{lender} ने अभी आपको कोई मान्य कोटेशन नहीं दिया है।',
  'loans.quote.request': '{lender} से कोटेशन माँगें',
  'loans.quote.requestCorrected': '{lender} से सुधारा हुआ कोटेशन माँगें',
  'loans.quote.requesting': 'भेजा जा रहा है…',
  'loans.quote.sent': 'आपका अनुरोध {lender} को भेज दिया गया।',
  'loans.quote.attribution': '{lender} का कोटेशन, संदर्भ {ref}',
  'loans.quote.asOf': '{date} तक की स्थिति',
  'loans.quote.validUntil': '{date} तक मान्य',
  'loans.quote.principal': 'मूलधन',
  'loans.quote.interest': 'ब्याज',
  'loans.quote.charges': 'शुल्क',
  'loans.quote.prepayment': 'अग्रिम भुगतान शुल्क',
  'loans.quote.total': '{lender} द्वारा बताया गया कुल',
  'loans.quote.mismatch':
    'इस कोटेशन के हिस्से उसके कुल से मेल नहीं खाते। {lender} से सुधारा हुआ कोटेशन माँगें। इस कोटेशन के लिए भुगतान का विकल्प नहीं दिया जा रहा।',
  'loans.quote.pay': 'इस कोटेशन का भुगतान करें',
  'loans.quote.letter': 'कोटेशन पत्र खोलें',

  // ---- closure --------------------------------------------------------------------------------------------------------
  'loans.closure.title': 'बंदी और बकाया-नहीं पत्र',
  'loans.closure.none': '{lender} ने इस ऋण को बंद होने की सूचना नहीं दी है।',
  'loans.closure.kind.closed': '{lender} ने इस ऋण को बंद बताया है।',
  'loans.closure.kind.foreclosed': '{lender} ने इस ऋण को समय से पहले बंद बताया है।',
  'loans.closure.recorded':
    'इस ऐप में {date} को दर्ज हुआ। यह ज़रूरी नहीं कि वही तिथि हो जब ऋणदाता ने ऋण बंद किया।',
  'loans.closure.noc.heading': 'बकाया-नहीं पत्र (एनओसी)',
  'loans.closure.noc.pending':
    '{lender} ने अभी यह नहीं बताया कि उसने बकाया-नहीं पत्र (एनओसी) जारी कर दिया है।',
  'loans.closure.noc.issued':
    '{lender} ने बताया है कि उसने बकाया-नहीं पत्र (एनओसी) जारी कर दिया है।',
  'loans.closure.noc.open': 'बकाया-नहीं पत्र खोलें',
  'loans.closure.issuedOn': '{date} को जारी, जैसा ऋणदाता ने बताया।',
  'loans.closure.sec.heading': 'इस ऋण के लिए रखी गई जमानत',
  'loans.closure.sec.mutual_fund_lien.pending':
    '{lender} को आपकी म्यूचुअल फ़ंड यूनिटों पर लगा लियन हटाना है। {lender} ने अभी पुष्टि नहीं की कि यह हो गया है।',
  'loans.closure.sec.mutual_fund_lien.confirmed':
    '{lender} ने पुष्टि की है कि उसने आपकी म्यूचुअल फ़ंड यूनिटों पर लगा लियन हटा दिया है।',
  'loans.closure.sec.demat_pledge.pending':
    '{lender} को आपकी प्रतिभूतियों पर लगा गिरवी हटाना है। {lender} ने अभी पुष्टि नहीं की कि यह हो गया है।',
  'loans.closure.sec.demat_pledge.confirmed':
    '{lender} ने पुष्टि की है कि उसने आपकी प्रतिभूतियों पर लगा गिरवी हटा दिया है।',
  'loans.closure.sec.property_documents.pending':
    '{lender} को आपके संपत्ति दस्तावेज़ लौटाने हैं। {lender} ने अभी पुष्टि नहीं की कि यह हो गया है।',
  'loans.closure.sec.property_documents.confirmed':
    '{lender} ने पुष्टि की है कि उसने आपके संपत्ति दस्तावेज़ लौटा दिए हैं।',
  'loans.closure.sec.vehicle_hypothecation.pending':
    '{lender} को आपके वाहन पर लगा हाइपोथिकेशन हटाना है। {lender} ने अभी पुष्टि नहीं की कि यह हो गया है।',
  'loans.closure.sec.vehicle_hypothecation.confirmed':
    '{lender} ने पुष्टि की है कि उसने आपके वाहन पर लगा हाइपोथिकेशन हटा दिया है।',
  'loans.closure.sec.other.pending':
    '{lender} को इस ऋण के लिए रखी जमानत छोड़नी है। {lender} ने अभी पुष्टि नहीं की कि यह हो गया है।',
  'loans.closure.sec.other.confirmed':
    '{lender} ने पुष्टि की है कि उसने इस ऋण के लिए रखी जमानत छोड़ दी है।',
  'loans.closure.unknown': 'इस मद की स्थिति के बारे में {lender} से पूछें।',
  'loans.closure.delay': 'देरी के लिए {lender} द्वारा दिया गया कारण',
  'loans.closure.confirmedOn': '{date} को पुष्टि हुई, जैसा ऋणदाता ने बताया।',
  'loans.closure.footer':
    'हर मद की स्थिति {lender} से आती है। यह ऐप कोई जमानत न रखता है, न छोड़ता है, और कोई पत्र जारी नहीं करता।',

  // ---- errors of these screens --------------------------------------------------------------------------------------
  'loans.err.notFound':
    'हमें यह नहीं मिला। हो सकता है इसे हटा दिया गया हो, या आपका ऋणदाता अब इसे यहाँ साझा न करता हो।',
  'loans.err.featureDisabled': 'यह सुविधा इस ऋणदाता के लिए अभी उपलब्ध नहीं है।',
  'loans.err.statusNotEligible': 'इस ऋण के लिए अभी विवरण नहीं माँगा जा सकता।',
  'loans.err.loanNotActive': 'समय-पूर्व बंदी का कोटेशन केवल चालू ऋण के लिए माँगा जा सकता है।',
  'loans.err.openRequestExists': 'इस प्रकार का एक अनुरोध पहले से खुला है। वह यहाँ सूची में है।',
  'loans.err.conflict':
    'यह अनुरोध पहले के एक अनुरोध से टकराता है। कृपया अपने अनुरोध देखकर फिर कोशिश करें।',
  'loans.err.periodInvalid':
    'कृपया तिथियाँ जाँचें। अवधि शुरू होने से पहले समाप्त नहीं हो सकती और भविष्य तक नहीं जा सकती।',
  'loans.err.requestNotOpen': 'यह अनुरोध अब खुला नहीं है, इसलिए रद्द नहीं किया जा सकता।',
  'loans.err.cursor': 'सूची आगे नहीं बढ़ाई जा सकी। कृपया फिर से शुरू करें।',
  'loans.err.documentsUnavailable':
    'दस्तावेज़ अभी नहीं खोले जा सकते। कृपया बाद में फिर कोशिश करें।',
  'loans.err.noAccess': 'इस खाते को ऋण की जानकारी देखने की अनुमति नहीं है।',

  // ---- messages from lenders (reminders) ----------------------------------------------------------------------------
  'reminders.title': 'आपके ऋणदाताओं के संदेश',
  'reminders.intro':
    'ये वे संदेश हैं जो आपके ऋणदाताओं ने हमसे आपको दिखाने को कहा। इन्हें ठीक वैसे दिखाया जाता है जैसे ऋणदाता ने लिखा।',
  'reminders.empty': 'आपके पास कोई संदेश नहीं है।',
  'reminders.unread': 'नया',
  'reminders.open': 'यह संदेश पढ़ें',
  'reminders.hide': 'यह संदेश छिपाएँ',
  'reminders.from': '{lender} की ओर से',
  'reminders.fromUnknown': 'एक ऋणदाता की ओर से',
  'reminders.kind.pre_due': 'देय तिथि से पहले की याद दिलाई',
  'reminders.kind.due_day': 'देय तिथि पर याद दिलाई',
  'reminders.kind.overdue': 'अतिदेय राशि के बारे में याद दिलाई',
  'reminders.kind.unknown': 'ऋणदाता का संदेश',
  'reminders.dueOn': 'देय तिथि: {date}',
  'reminders.sentOn': 'भेजा गया: {date}',
  'reminders.goToLoan': 'इस ऋण पर जाएँ',
};
