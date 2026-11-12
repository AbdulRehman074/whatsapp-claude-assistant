// Offline stand-in for Claude, used only with MOCK_CLAUDE=1 (tests, demos without an API key).
// It is deliberately simple; real sorting and drafting come from Claude.
const LANG = [
  ['nl', /\b(hallo|goedemiddag|goedemorgen|prijs|graag|bedankt|machine nog|beschikbaar|wanneer|ophalen)\b/i],
  ['fr', /\b(bonjour|prix|merci|disponible|machine est|livraison|est-ce)\b/i],
  ['es', /\b(hola|precio|gracias|disponible|todavía|cuánto|envío)\b/i],
];
const REPLY = {
  en: 'Hi, thanks for your message! The machine is [available / sold]. The price is [price]. When would you like to come and see it?',
  nl: 'Hallo, bedankt voor uw bericht! De machine is [beschikbaar / verkocht]. De prijs is [prijs]. Wanneer wilt u hem komen bekijken?',
  fr: 'Bonjour, merci pour votre message ! La machine est [disponible / vendue]. Le prix est de [prix]. Quand souhaitez-vous venir la voir ?',
  es: 'Hola, ¡gracias por su mensaje! La máquina está [disponible / vendida]. El precio es [precio]. ¿Cuándo le gustaría venir a verla?',
};

const MACHINE_RE = /\b(volvo|caterpillar|cat|john deere|komatsu|toyota|yanmar|liebherr|jcb|hitachi|manitou)\b[\w\s-]{0,30}/i;
export function mockClassify(msgs, channel = {}) {
  const last = [...msgs].reverse().find((m) => m.direction === 'in')?.text || '';
  const all = msgs.filter((m) => m.direction === 'in').map((m) => m.text).join(' ');
  const language = (LANG.find(([, re]) => re.test(all)) || ['en'])[0];
  let category = 'other_business';
  if (/(mama|mom|dad|papa|habibi|schat|dinner|eten vanavond|family|familie)/i.test(all)) category = 'personal';
  else if (/(promo|discount|korting|seo|marketing services|click here|winner)/i.test(all)) category = 'spam_ads';
  else if (/(we offer|wij bieden|we have .* for sale|supplier|leverancier|nous proposons|ofrecemos)/i.test(all)) category = 'supplier';
  else if (/(invoice|factuur|facture|factura|paid|betaald|payé|pickup|ophalen|delivery status)/i.test(all)) category = 'existing_customer';
  else if (/(transport|truck|vrachtwagen|shipping|camion|container)/i.test(all)) category = 'transport';
  else if (/(machine|price|prijs|prix|precio|excavator|graafmachine|tractor|forklift|heftruck|available|beschikbaar|disponible|http)/i.test(all)) category = 'machine_inquiry';
  const urgent = ['machine_inquiry', 'supplier'].includes(category);
  const source = /https?:\/\//.test(all) ? 'website_or_marketplace' : 'direct';
  const noDraft = ['personal', 'spam_ads'].includes(category);
  const mm = all.match(MACHINE_RE);
  const machines = mm && ['machine_inquiry', 'supplier'].includes(category) ? [{ machine: mm[0].trim(), details: '' }] : [];
  const drafts = !!channel.drafts_enabled;
  return {
    category, urgent, language, source, machines, country: '',
    needs_reply: !noDraft && !/^(ok|thanks|thank you|bedankt|merci|gracias)[.! ]*$/i.test(last.trim()),
    summary: category === 'personal' ? 'Personal message' : `[mock] ${last.slice(0, 80)}`,
    draft: noDraft || !drafts ? '' : REPLY[language],
    needs_info: noDraft || !drafts ? [] : ['Availability', 'Price'],
  };
}

export function mockSummary(items, dateLabel) {
  const biz = items.filter((i) => i.category !== 'personal');
  const open = biz.filter((i) => i.status === 'open');
  return `Summary ${dateLabel}\n${biz.length} business chats, ${open.filter((i) => i.urgent).length} urgent still open.\n` +
    open.slice(0, 8).map((i) => `- ${i.name || '+' + i.contact}: ${i.summary}`).join('\n');
}
