import { type enPayments } from './en.payments';

/**
 * Hindi text for the same keys. DRAFT like the rest of hi.ts: not reviewed by a native speaker or by counsel. Plain and calm; no
 * urgency. "Received by the payment provider" is never written as "paid to the lender".
 */
export const hiPayments: Record<keyof typeof enPayments, string> = {
  // ---- paying: options ----
  'pay.title': 'भुगतान करें',
  'pay.intro':
    'आप यहाँ तय करते हैं कि क्या चुकाना है और उसकी पुष्टि करते हैं। भुगतान आप भुगतान प्रदाता के पेज पर करते हैं, इस ऐप में नहीं। राशि {lender} तय करता है।',
  'pay.lender': 'ऋणदाता: {lender}',
  'pay.destination': 'इस ऋण के भुगतान {lender} के खाते {account} में जाते हैं',
  'pay.reportedAsOf': '{lender} द्वारा {date} को बताया गया',
  'pay.stale':
    'ये आँकड़े पुराने हैं। {lender} ने इन्हें आख़िरी बार {date} को बताया था। जब तक {lender} नए आँकड़े नहीं बताता, इन पर निर्भर भुगतान शुरू नहीं किए जा सकते।',
  'pay.staleNoDate':
    'ये आँकड़े पुराने हैं। जब तक {lender} नए आँकड़े नहीं बताता, इन पर निर्भर भुगतान शुरू नहीं किए जा सकते।',
  'pay.withheld':
    '{lender} इन आँकड़ों की जाँच कर रहा है। जब तक {lender} इनकी पुष्टि नहीं करता, कोई राशि नहीं दिखाई जाएगी।',
  'pay.unavailable.loan_not_active':
    'यह ऋण सक्रिय नहीं है, इसलिए ऐप में भुगतान शुरू नहीं किया जा सकता। कोई प्रश्न हो तो कृपया {lender} से संपर्क करें।',
  'pay.unavailable.collection_target_invalid':
    'हम यह पुष्टि नहीं कर सके कि {lender} भुगतान कहाँ प्राप्त करता है, इसलिए अभी ऐप में भुगतान नहीं दिए जा रहे। कृपया {lender} से संपर्क करें।',
  'pay.unavailable.config_ambiguous':
    'ऐप में भुगतान देने से पहले {lender} की भुगतान व्यवस्था की जाँच ज़रूरी है। कृपया {lender} से संपर्क करें।',
  'pay.unavailable.unknown': 'अभी ऐप में भुगतान शुरू नहीं किया जा सकता।',
  'pay.noneOffered':
    'अभी ऐप में कोई भुगतान शुरू नहीं किया जा सकता। ऐप में कौन-से भुगतान दिए जाएँ, यह {lender} तय करता है।',
  'pay.open.title': 'चल रहे भुगतान',
  'pay.open.note':
    'इस ऋण पर आपका एक भुगतान पहले से चल रहा है। वह कहाँ तक पहुँचा, यह देखने के लिए उसे खोलें।',
  'pay.open.item': '{purpose} — {status}',
  'pay.open.view': 'भुगतान देखें: {purpose}',
  'pay.choose': 'आप क्या चुकाना चाहते हैं?',
  'pay.chooseNote': 'आपके लिए कुछ भी पहले से चुना हुआ नहीं है। एक विकल्प चुनें।',
  'pay.purpose.installment': 'अगली किस्त',
  'pay.purpose.overdue': 'अतिदेय राशि',
  'pay.purpose.part_prepayment': 'आंशिक पूर्व-भुगतान',
  'pay.purpose.foreclosure': 'फ़ोरक्लोज़र (ऋण का पूरा भुगतान)',
  'pay.purpose.charges': 'शुल्क',
  'pay.purpose.unknown': 'भुगतान',
  'pay.source.reported': '{lender} द्वारा तय राशि: ₹{amount}',
  'pay.source.quote': '{lender} के कोटेशन में तय राशि: ₹{amount}',
  'pay.source.limits': 'राशि आप चुनते हैं, {lender} की तय सीमा के भीतर: ₹{min} से ₹{max}',
  'pay.due': 'देय तिथि {date}',
  'pay.partial': 'कम राशि भी {lender} की तय सीमा के भीतर स्वीकार है: ₹{min} से ₹{max}।',
  'pay.quote.validUntil': 'कोटेशन {date} तक मान्य है।',
  'pay.quote.flagged':
    '{lender} का कोटेशन जोड़ पर सही नहीं बैठता, इसलिए {lender} के सुधारने तक इसका भुगतान ऐप में नहीं हो सकता।',
  'pay.penal.label': '{lender} की ओर से',
  'pay.mode.reported': '₹{amount} चुकाएँ, जो {lender} द्वारा तय राशि है',
  'pay.mode.other': 'कोई और राशि चुकाएँ, {lender} की तय सीमा के भीतर',
  'pay.amountLabel': 'राशि रुपयों में',
  'pay.amountHint': '₹{min} और ₹{max} के बीच',
  'pay.amount.invalid': 'रुपयों में राशि लिखें, जैसे 5,000 या 5000.50।',
  'pay.amount.tooLow': 'राशि कम से कम ₹{min} होनी चाहिए।',
  'pay.amount.tooHigh': 'राशि अधिक से अधिक ₹{max} हो सकती है।',
  'pay.summary.title': 'शुरू करने से पहले जाँचें',
  'pay.summary.line': 'आप {lender} को ₹{amount} ({purpose}) का भुगतान शुरू करने वाले हैं।',
  'pay.summary.next':
    'अगली स्क्रीन दिखाएगी कि भुगतान कहाँ तक पहुँचा। भुगतान आप भुगतान प्रदाता के पेज पर करेंगे।',
  'pay.start': 'यह भुगतान शुरू करें',
  'pay.starting': 'शुरू हो रहा है…',
  'pay.chooseFirst': 'आगे बढ़ने के लिए चुनें कि क्या चुकाना है।',
  'pay.refresh': 'फिर जाँचें',
  'pay.refreshFailed': 'अभी जानकारी ताज़ा नहीं हो सकी। जो दिख रहा है वह पुराना हो सकता है।',

  // ---- paying: errors ----
  'pay.err.conflict':
    'यह अनुरोध पहले के एक अनुरोध से टकराता है जिसका विवरण अलग था। कृपया वापस जाकर फिर से शुरू करें।',
  'pay.err.amountNotAllowed': 'यह राशि मान्य नहीं है। कृपया दिखाई गई सीमाएँ जाँचकर फिर कोशिश करें।',
  'pay.err.featureOff': 'यह सुविधा अभी इस ऋणदाता के लिए उपलब्ध नहीं है।',
  'pay.err.loanNotActive': 'यह ऋण सक्रिय नहीं है, इसलिए भुगतान शुरू नहीं किया जा सकता।',
  'pay.err.targetInvalid':
    'इस ऋणदाता को भुगतान अभी ऐप में शुरू नहीं किया जा सकता। कृपया ऋणदाता से संपर्क करें।',
  'pay.err.figuresUnavailable':
    'ऋणदाता के आँकड़े अभी उपलब्ध नहीं हैं, इसलिए यह भुगतान शुरू नहीं किया जा सकता। कृपया बाद में फिर जाँचें।',
  'pay.err.stale':
    'ऋणदाता के आँकड़े पुराने हैं, इसलिए ऋणदाता के नए आँकड़े बताने तक यह भुगतान शुरू नहीं किया जा सकता।',
  'pay.err.nothingDue': 'ऋणदाता ने इस भुगतान के लिए कोई देय राशि नहीं बताई है।',
  'pay.err.purposeOff': 'इस ऋण के लिए इस प्रकार का भुगतान ऐप में उपलब्ध नहीं है।',
  'pay.err.quoteRequired': 'इस भुगतान के लिए ऋणदाता का वर्तमान कोटेशन ज़रूरी है।',
  'pay.err.quoteNotCurrent':
    'ऋणदाता का कोटेशन अब वर्तमान नहीं है। नवीनतम विकल्प स्क्रीन पर दिखाए गए हैं।',
  'pay.err.quoteFlagged':
    'ऋणदाता का कोटेशन जोड़ पर सही नहीं बैठता, इसलिए ऋणदाता के सुधारने तक इसका भुगतान नहीं हो सकता।',
  'pay.err.openExists':
    'इसके लिए आपका एक भुगतान पहले से चल रहा है। वह कहाँ तक पहुँचा, यह देखने के लिए उसे खोलें।',
  'pay.err.blocked': 'ऐप के इस संस्करण में भुगतान शुरू नहीं किए जा सकते।',
  'pay.err.notCancellable':
    'यह भुगतान अब रद्द नहीं हो सकता, क्योंकि भुगतान का पेज पहले से बन चुका है।',
  'pay.err.handoffUnavailable': 'ऐप के इस संस्करण में प्रदाता का पेज नहीं खोला जा सकता।',

  // ---- payment status ----
  'pay.status.title': 'भुगतान',
  'pay.status.created': 'शुरू हुआ',
  'pay.status.pending': 'शुरू हुआ, भुगतान प्रदाता के पास',
  'pay.status.succeeded': 'भुगतान प्रदाता ने बताया',
  'pay.status.failed': 'पूरा नहीं हुआ',
  'pay.status.expired': 'समय समाप्त',
  'pay.status.cancelled': 'रद्द',
  'pay.status.unknown': 'उपलब्ध नहीं',
  'pay.stage.started': 'भुगतान शुरू हुआ',
  'pay.stage.provider_received': 'भुगतान प्रदाता को मिला',
  'pay.stage.lender_posted': '{lender} ने इसे आपके ऋण में दर्ज कर लिया है',
  'pay.stage.needs_attention': 'ध्यान चाहिए: {lender} से संपर्क करें',
  'pay.stage.cancelled': 'भुगतान रद्द हुआ',
  'pay.stage.failed': 'भुगतान पूरा नहीं हुआ',
  'pay.stage.expired': 'भुगतान का समय समाप्त हो गया',
  'pay.stage.unknown':
    'इस भुगतान का चरण यहाँ नहीं दिखाया जा सकता। मदद चाहिए तो {lender} से संपर्क करें।',
  'pay.explain.started':
    'अभी तक कुछ भी प्राप्त होने की सूचना नहीं मिली है। यह स्क्रीन तभी बदलती है जब भुगतान प्रदाता या {lender} कुछ बताता है।',
  'pay.explain.provider_received':
    '"मिला" का अर्थ है कि भुगतान प्रदाता ने आपके भुगतान की सूचना दी है। इसका अर्थ अभी यह नहीं कि {lender} ने उसे आपके ऋण में दर्ज कर लिया है। यह {lender} अपने रिकॉर्ड में तय करता है।',
  'pay.explain.lender_posted':
    '{lender} के अपने रिकॉर्ड में यह भुगतान दिखता है। इसे आपके ऋण में कैसे लगाया जाए, यह {lender} का निर्णय है।',
  'pay.explain.needs_attention':
    'इस भुगतान में कुछ जाँचने लायक है, जैसे राशि का अलग होना। कृपया {lender} से संपर्क करें और तारीख़ व राशि बताएँ।',
  'pay.explain.cancelled': 'यह भुगतान रद्द किया गया था। इसके लिए कोई भुगतान पेज नहीं खुलेगा।',
  'pay.explain.failed':
    'भुगतान प्रदाता ने इस भुगतान के लिए पैसा मिलने की सूचना नहीं दी है। यदि आपके खाते से पैसा कटा है, तो कृपया {lender} से संपर्क करें।',
  'pay.explain.expired':
    'भुगतान पेज का समय समाप्त हो गया और भुगतान प्रदाता ने इसके लिए पैसा मिलने की सूचना नहीं दी है। यदि आपके खाते से पैसा कटा है, तो कृपया {lender} से संपर्क करें।',
  'pay.detail.amount': 'राशि: ₹{amount}',
  'pay.detail.purpose': 'किसके लिए: {purpose}',
  'pay.detail.started': '{date} को शुरू हुआ',
  'pay.detail.providerAt': 'भुगतान प्रदाता ने {date} को बताया',
  'pay.detail.postedOn': '{lender} ने मूल्य तिथि {date} के साथ दर्ज किया',
  'pay.wait.order':
    'भुगतान का पेज तैयार हो रहा है। इसमें थोड़ा समय लग सकता है। आप इस स्क्रीन से जाकर बाद में लौट सकते हैं।',
  'pay.wait.afterReturn':
    'भुगतान पेज से लौटने से यह पता नहीं चलता कि भुगतान हुआ या नहीं। हम देख रहे हैं कि भुगतान प्रदाता और {lender} क्या बताते हैं।',
  'pay.wait.stopped': 'हमने अपने-आप जाँचना रोक दिया है। ताज़ा स्थिति के लिए "फिर जाँचें" दबाएँ।',
  'pay.link.button': 'भुगतान पेज पर जाएँ',
  'pay.link.note':
    'भुगतान का पेज आपके ब्राउज़र में खुलता है। उसे भुगतान प्रदाता चलाता है। भुगतान आप वहीं करते हैं, इस ऐप में नहीं।',
  'pay.link.until': 'यह पेज {date} तक खोला जा सकता है।',
  'pay.link.opening': 'खुल रहा है…',
  'pay.link.failed': 'भुगतान का पेज खोला नहीं जा सका। कृपया फिर कोशिश करें।',
  'pay.link.unavailable':
    'भुगतान का पेज अभी उपलब्ध नहीं है। ताज़ा स्थिति के लिए "फिर जाँचें" दबाएँ।',
  'pay.link.none': 'अभी खोलने के लिए कोई भुगतान पेज नहीं है।',
  'pay.cancel.button': 'यह भुगतान रद्द करें',
  'pay.cancel.note': 'आप इसे तभी रद्द कर सकते हैं जब तक भुगतान का पेज तैयार न हुआ हो।',
  'pay.cancel.busy': 'रद्द हो रहा है…',
  'pay.again': 'भुगतान विकल्पों पर वापस',

  // ---- mandates: list and setup ----
  'mandate.title': 'ऑटो-पे',
  'mandate.list.title': 'आपके ऑटो-पे मैंडेट',
  'mandate.list.intro':
    'ऑटो-पे मैंडेट आपके बैंक को दिया गया एक निर्देश है, जिससे आपका ऋणदाता ऋण की किस्तें डेबिट करने का अनुरोध कर सकता है। इसे रद्द करने का अनुरोध आप यहाँ कर सकते हैं।',
  'mandate.list.empty': 'आपके पास कोई ऑटो-पे मैंडेट नहीं है।',
  'mandate.open': 'खोलें: {lender}',
  'mandate.setup.title': 'ऑटो-पे चालू करें',
  'mandate.setup.intro':
    'ऑटो-पे आपके बैंक को दिया गया निर्देश है। आपका बैंक और प्रदाता इसकी पुष्टि कर दें, तो {lender} नीचे दिखाई सीमा तक आपके खाते से डेबिट का अनुरोध आपके बैंक से कर सकता है। यह तभी चालू होता है जब प्रदाता इसकी पुष्टि करता है।',
  'mandate.setup.requirement.optional': '{lender} ने ऑटो-पे को वैकल्पिक बताया है।',
  'mandate.setup.requirement.before_first_due':
    '{lender} चाहता है कि पहली देय तिथि से पहले ऑटो-पे चालू हो जाए। यह {lender} की अपनी व्यवस्था है।',
  'mandate.setup.lead':
    'डेबिट से पहले की सूचना {hours} घंटे पहले भेजने के लिए तय है। यह एक सेटिंग है, सूचना पहुँचने की गारंटी नहीं।',
  'mandate.setup.existing': 'इस ऋण के लिए आपके पास पहले से एक ऑटो-पे मैंडेट है।',
  'mandate.setup.viewExisting': 'उसे देखें',
  'mandate.setup.rails': 'चुनें कि इसे कैसे चालू करना है',
  'mandate.setup.railsNote': 'आपके लिए कुछ भी पहले से चुना हुआ नहीं है। एक विकल्प चुनें।',
  'mandate.setup.notInThisVersion':
    'ऑटो-पे चालू करना ऐप के इस संस्करण में उपलब्ध नहीं है। आप जब चाहें, एक बार का भुगतान फिर भी कर सकते हैं।',
  'mandate.setup.payOnce': 'एक बार का भुगतान करें',
  'mandate.unavailable.loan_not_active':
    'यह ऋण सक्रिय नहीं है, इसलिए ऑटो-पे चालू नहीं किया जा सकता। कोई प्रश्न हो तो कृपया {lender} से संपर्क करें।',
  'mandate.unavailable.collection_target_invalid':
    'हम यह पुष्टि नहीं कर सके कि {lender} भुगतान कहाँ प्राप्त करता है, इसलिए अभी ऐप में ऑटो-पे नहीं दिया जा रहा। कृपया {lender} से संपर्क करें।',
  'mandate.unavailable.config_ambiguous':
    'ऑटो-पे देने से पहले {lender} की भुगतान व्यवस्था की जाँच ज़रूरी है। कृपया {lender} से संपर्क करें।',
  'mandate.unavailable.provider_not_mandate_capable':
    '{lender} के भुगतान प्रदाता के साथ ऑटो-पे उपलब्ध नहीं है।',
  'mandate.unavailable.rail_not_configured':
    '{lender} ने ऑटो-पे चालू करने का कोई तरीका अभी उपलब्ध नहीं कराया है।',
  'mandate.unavailable.mandate_exists': 'इस ऋण के लिए आपके पास पहले से एक ऑटो-पे मैंडेट है।',
  'mandate.unavailable.unknown': 'अभी ऐप में ऑटो-पे चालू नहीं किया जा सकता।',
  'mandate.rail.enach_api': 'ई-एनएसीएच (नेट बैंकिंग या डेबिट कार्ड)',
  'mandate.rail.upi_autopay': 'यूपीआई ऑटोपे',
  'mandate.rail.unknown': 'ऑटो-पे',
  'mandate.rail.effect.enach_api':
    'आप इसे अपने बैंक या प्रदाता के चलाए पेज पर, नेट बैंकिंग या डेबिट कार्ड से मंज़ूर करते हैं। प्रदाता की पुष्टि के बाद {lender} सीमा तक डेबिट के लिए आपके बैंक से अनुरोध कर सकता है।',
  'mandate.rail.effect.upi_autopay':
    'आप इसे यूपीआई के ज़रिए मंज़ूर करते हैं। प्रदाता की पुष्टि के बाद {lender} सीमा तक यूपीआई से डेबिट का अनुरोध कर सकता है।',
  'mandate.rail.effect.unknown':
    'प्रदाता की पुष्टि के बाद {lender} सीमा तक डेबिट का अनुरोध कर सकता है।',
  'mandate.rail.max': 'एक डेबिट की अधिकतम राशि: ₹{amount}',
  'mandate.rail.maxNote':
    'यह इस तरीके की सीमा और {lender} की तय ऊपरी सीमा में से जो कम है, वही है।',
  'mandate.rail.afa': 'आपका बैंक हर डेबिट पर आपसे मंज़ूरी माँग सकता है।',
  'mandate.start': 'शुरू होने की तारीख़',
  'mandate.end': 'समाप्ति की तारीख़',
  'mandate.dateHint': 'दिन/माह/वर्ष',
  'mandate.date.invalid': 'सही तारीख़ दिन/माह/वर्ष (DD/MM/YYYY) के रूप में लिखें।',
  'mandate.dates.note': 'अनुरोध भेजते समय शुरू और समाप्ति की तारीख़ों की जाँच होती है।',
  'mandate.account.label': 'आपके बैंक खाता संख्या के अंतिम 4 अंक',
  'mandate.account.hint': 'केवल अंतिम 4 अंक लिखें। पूरी खाता संख्या कभी न लिखें।',
  'mandate.account.invalid': 'ठीक 4 अंक लिखें।',
  'mandate.account.preview': 'आपका खाता {account} के रूप में दिखेगा।',
  'mandate.step.title': 'चरण 1: एक बार वाले कोड से पुष्टि करें',
  'mandate.step.note':
    'यह कोड इसी अनुरोध से जुड़ा है। बाद में दोबारा शुरू करने पर आपको नया कोड चाहिए होगा।',
  'mandate.step.button': 'कोड मँगाएँ और लिखें',
  'mandate.send.title': 'चरण 2: अनुरोध भेजें',
  'mandate.summary':
    'अनुरोध: {rail}, एक डेबिट के लिए अधिकतम ₹{amount}, {start} से {end} तक, बैंक खाता {account}।',
  'mandate.create': 'ऑटो-पे का अनुरोध भेजें',
  'mandate.creating': 'भेजा जा रहा है…',
  'mandate.chooseRail': 'पहले चुनें कि इसे कैसे चालू करना है।',

  // ---- mandates: errors ----
  'mandate.err.stepup':
    'इस अनुरोध के लिए एक बार वाले कोड की जाँच ज़रूरी है। चरण 1 में कोड से पुष्टि करें, फिर अनुरोध दोबारा भेजें।',
  'mandate.err.integrity':
    'ऐप के इस संस्करण में ऑटो-पे चालू नहीं किया जा सकता, इसलिए अनुरोध स्वीकार नहीं हुआ। आप फिर भी एक बार का भुगतान कर सकते हैं।',
  'mandate.err.providerNotCapable': 'इस ऋणदाता के भुगतान प्रदाता के साथ ऑटो-पे उपलब्ध नहीं है।',
  'mandate.err.creditor':
    'इस ऋणदाता के लिए अभी ऑटो-पे चालू नहीं किया जा सकता। कृपया ऋणदाता से संपर्क करें।',
  'mandate.err.rail': 'ऑटो-पे चालू करने का यह तरीका इस ऋणदाता के लिए उपलब्ध नहीं है।',
  'mandate.err.exists': 'इस ऋण के लिए आपके पास पहले से एक ऑटो-पे मैंडेट है।',
  'mandate.err.dates': 'कृपया शुरू और समाप्ति की तारीख़ें जाँचकर फिर कोशिश करें।',
  'mandate.err.account': 'खाता संख्या के केवल अंतिम 4 अंक लिखें।',
  'mandate.err.finished': 'यह ऑटो-पे पहले ही समाप्त हो चुका है, इसलिए इसे रद्द नहीं किया जा सकता।',

  // ---- mandates: detail ----
  'mandate.detail.title': 'ऑटो-पे मैंडेट',
  'mandate.lender': 'ऋणदाता: {lender}',
  'mandate.account': 'बैंक खाता: {account}',
  'mandate.max': 'एक डेबिट की अधिकतम राशि: ₹{amount}',
  'mandate.period': '{start} से {end} तक',
  'mandate.status.draft': 'अनुरोध किया गया',
  'mandate.status.registration_pending': 'आपके बैंक की प्रतीक्षा',
  'mandate.status.active': 'चालू',
  'mandate.status.paused': 'रोका गया',
  'mandate.status.rejected': 'अस्वीकृत',
  'mandate.status.failed': 'पूरा नहीं हुआ',
  'mandate.status.expired': 'समाप्त',
  'mandate.status.cancelled': 'रद्द',
  'mandate.status.revoked': 'वापस लिया गया',
  'mandate.status.requires_reconciliation': 'जाँच जारी है',
  'mandate.status.unknown': 'स्थिति उपलब्ध नहीं',
  'mandate.explain.draft':
    'आपका अनुरोध मिल गया है। हम प्रदाता से मंज़ूरी का पेज तैयार करने को कह रहे हैं। अभी कुछ भी चालू नहीं हुआ है।',
  'mandate.explain.registration_pending':
    'आपके बैंक की प्रतीक्षा है। आगे बढ़ने के लिए मंज़ूरी का पेज खोलें। ऑटो-पे तभी चालू होता है जब प्रदाता इसकी पुष्टि करता है।',
  'mandate.explain.active': 'चालू, जैसा प्रदाता ने पुष्टि की है।',
  'mandate.explain.paused': 'रोका गया, जैसा प्रदाता ने बताया है।',
  'mandate.explain.rejected': 'बैंक या प्रदाता ने इस अनुरोध को स्वीकार नहीं किया।',
  'mandate.explain.failed': 'चालू करने की प्रक्रिया पूरी नहीं हुई।',
  'mandate.explain.expired': 'यह ऑटो-पे समाप्त हो चुका है, जैसा प्रदाता ने बताया है।',
  'mandate.explain.cancelled': 'रद्द, जैसा प्रदाता ने पुष्टि की है।',
  'mandate.explain.revoked': 'यह ऑटो-पे बैंक में वापस ले लिया गया, जैसा प्रदाता ने बताया है।',
  'mandate.explain.requires_reconciliation':
    'प्रदाता का परिणाम अभी पता नहीं है। हम प्रदाता और {lender} से जाँच कर रहे हैं।',
  'mandate.explain.unknown': 'मदद चाहिए तो {lender} से संपर्क करें।',
  'mandate.cancelRequested':
    'रद्द करने का अनुरोध भेजा गया है। जब तक प्रदाता पुष्टि नहीं करता, यह केवल एक अनुरोध है। ऊपर की स्थिति बदली नहीं है।',
  'mandate.cancel.button': 'रद्द करने का अनुरोध करें',
  'mandate.cancel.confirmTitle': 'क्या इस ऑटो-पे को रद्द करने का अनुरोध करें?',
  'mandate.cancel.confirmBody':
    'इससे प्रदाता को रद्द करने का अनुरोध जाएगा। यह केवल एक अनुरोध है: जब तक प्रदाता पुष्टि नहीं करता, ऑटो-पे जैसा है वैसा ही रहता है।',
  'mandate.cancel.send': 'रद्द करने का अनुरोध भेजें',
  'mandate.cancel.keep': 'जैसा है वैसा रहने दें',
  'mandate.cancel.busy': 'भेजा जा रहा है…',
  'mandate.next.title': 'अगला नियोजित डेबिट',
  'mandate.next.line': '{date} को: ₹{amount}',
  'mandate.next.noAmount': '{date}: राशि अभी नहीं बताई गई',
  'mandate.next.none': 'कोई नियोजित डेबिट नहीं बताया गया है।',
  'mandate.next.noticeSent': 'इस डेबिट की सूचना भेजी जा चुकी है।',
  'mandate.next.noticeNot': 'इस डेबिट की सूचना अभी भेजी नहीं गई है।',
  'mandate.next.note':
    'नियोजित डेबिट {lender} के बताए कार्यक्रम से आते हैं। यह कोई वादा नहीं है कि डेबिट होगा या नहीं होगा।',
  'mandate.debits.title': 'डेबिट',
  'mandate.debits.empty': 'इस ऑटो-पे के लिए कोई डेबिट नहीं बताया गया है।',
  'mandate.debit.planned': 'नियोजित',
  'mandate.debit.reported': 'प्रदाता ने बताया',
  'mandate.debit.amount': 'राशि: ₹{amount}',
  'mandate.debit.noAmount': 'राशि नहीं बताई गई',
  'mandate.debit.status.scheduled': 'निर्धारित',
  'mandate.debit.status.notified': 'सूचना भेजी गई',
  'mandate.debit.status.presented': 'आपके बैंक को भेजा गया',
  'mandate.debit.status.unknown': 'परिणाम अभी पता नहीं',
  'mandate.debit.status.settled': 'निपटा हुआ बताया गया',
  'mandate.debit.status.returned': 'लौटाया गया',
  'mandate.debit.status.cancelled': 'रद्द',
  'mandate.debit.status.other': 'स्थिति उपलब्ध नहीं',
  'mandate.debit.noClass': 'कारण का कोई वर्ग तय नहीं किया गया है।',
  'mandate.debit.class.insufficient_funds': 'कारण का वर्ग: अपर्याप्त शेष राशि',
  'mandate.debit.class.account_issue': 'कारण का वर्ग: खाते से जुड़ी समस्या',
  'mandate.debit.class.mandate_issue': 'कारण का वर्ग: मैंडेट से जुड़ी समस्या',
  'mandate.debit.class.technical': 'कारण का वर्ग: तकनीकी',
  'mandate.debit.class.other': 'कारण का वर्ग: अन्य',
  'mandate.notice.planned': 'सूचना {date} के लिए नियोजित',
  'mandate.notice.sent': 'सूचना {date} को भेजी गई',
  'mandate.notice.late': 'सूचना देर से थी (यह {date} तक देय थी)',
  'mandate.notice.not_needed': 'इस डेबिट के लिए सूचना की ज़रूरत नहीं',
  'mandate.link.button': 'मंज़ूरी के लिए आगे बढ़ें',
  'mandate.link.note':
    'मंज़ूरी का पेज आपके ब्राउज़र में खुलता है। उसे आपका बैंक या प्रदाता चलाता है। वहाँ से लौटने से अपने-आप यह साबित नहीं होता कि ऑटो-पे चालू हो गया है।',
  'mandate.link.opening': 'खुल रहा है…',
  'mandate.link.failed': 'मंज़ूरी का पेज खोला नहीं जा सका। कृपया फिर कोशिश करें।',
  'mandate.link.unavailable':
    'मंज़ूरी का पेज अभी उपलब्ध नहीं है। ताज़ा स्थिति के लिए "फिर जाँचें" दबाएँ।',
  'mandate.wait.afterReturn':
    'हम देख रहे हैं कि प्रदाता क्या बताता है। स्थिति तभी बदलती है जब प्रदाता पुष्टि करता है।',
  'mandate.wait.stopped':
    'हमने अपने-आप जाँचना रोक दिया है। ताज़ा स्थिति के लिए "फिर जाँचें" दबाएँ।',
};
