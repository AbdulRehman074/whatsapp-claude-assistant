import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { mockClassify, mockSummary } from './mock.js';

export const CATEGORIES = {
  machine_inquiry: 'Machine / price inquiry',
  supplier: 'Supplier',
  existing_customer: 'Existing customer',
  transport: 'Transport / logistics',
  other_business: 'Other business',
  spam_ads: 'Ads / spam',
  personal: 'Looks personal',
};

const TOOL = {
  name: 'file_message',
  description: 'File the latest customer message(s) for the owner: sort it, flag urgency and write a reply draft.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: Object.keys(CATEGORIES) },
      urgent: { type: 'boolean', description: 'true for machine/price inquiries, suppliers, and anything time-critical (complaint, payment, pickup today).' },
      language: { type: 'string', description: 'Language of the customer\'s latest message as an ISO code: en, nl, fr, es, de, ar, ...' },
      source: { type: 'string', enum: ['direct', 'website_or_marketplace'], description: 'website_or_marketplace when the message came through a machine listing site (contains a listing link, a reference number or the site\'s standard wording).' },
      summary: { type: 'string', description: 'One line in English for the owner: who, what they want, key details (machine, model, price asked, deadline). Max 20 words.' },
      draft: { type: 'string', description: 'Reply draft in the customer\'s language, WhatsApp style. Empty string for spam_ads and personal.' },
      needs_info: { type: 'array', items: { type: 'string' }, description: 'Things the owner must check or fill in before sending (in English), matching the [square bracket] placeholders in the draft.' },
    },
    required: ['category', 'urgent', 'language', 'source', 'summary', 'draft', 'needs_info'],
  },
};

const RULES = `You work inside the WhatsApp Business number of {OWNER}. Every new customer message is passed to you with the recent conversation. You sort it and prepare a reply draft. {OWNER} reads your draft on his phone, edits it if needed and sends it himself from the WhatsApp Business app. You never send anything.

Sorting:
- machine_inquiry: someone asking about a machine, its price, availability, specs, photos, a viewing, or making an offer. Includes inquiries forwarded from machine listing websites and marketplaces.
- supplier: someone offering or selling machines/parts to the company, or a supplier the company buys from.
- existing_customer: someone who already bought or ordered: payment, invoice, pickup, delivery status, documents, after-sales, complaints.
- transport: transport companies, shipping quotes, pickup planning with a carrier, customs/export paperwork.
- other_business: any other work-related message.
- spam_ads: promotions, cold sales pitches, bulk messages, scams. No draft.
- personal: family, friends, private life. No draft and a neutral summary without private details (for example "Personal message from Ahmed").
Urgent: always for machine_inquiry and supplier; also anything time-critical.

Drafting:
- Reply in the same language as the customer's latest message (English, Dutch, French, Spanish, or whatever they used).
- Friendly and professional, short, WhatsApp style. No subject lines, no long formal letters. One or two short paragraphs at most.
- Sign off with "{OWNER}" only when a sign-off feels natural; most WhatsApp replies need none.
- NEVER invent prices, stock, availability, delivery times, specifications or promises. Use only facts from the BUSINESS KNOWLEDGE below or from the conversation. When a fact is missing, write a clear placeholder in square brackets in the customer's language, e.g. [prijs] or [price], and list what to fill in under needs_info in English.
- If the customer only greets or the message is unclear, draft a friendly question asking what machine or help they need.
- For voice notes, photos or documents you cannot see, draft a short acknowledgement and add "Listen to / check the attachment" to needs_info.
- If {OWNER} already replied in the conversation and the customer has not written since, the draft can be an empty string.
- Do not repeat information {OWNER} already gave in the conversation.`;

export function knowledgeTemplate() {
  const file = path.resolve(config.knowledgeDir, 'template.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
function knowledgeFor(channel) {
  if (channel.knowledge_text && channel.knowledge_text.trim()) return channel.knowledge_text;
  const file = path.resolve(config.knowledgeDir, channel.knowledge_file || `${channel.id}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(no business knowledge file yet)';
}

async function messagesApi(body) {
  const res = await fetch(`${config.anthropicBase}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

function fmtConversation(channel, msgs, name) {
  return msgs.map((m) => {
    const who = m.direction === 'in' ? (name || 'Customer') : channel.owner_name;
    const t = new Date(m.ts).toLocaleString('en-GB', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' });
    return `[${t}] ${who}: ${m.text}`;
  }).join('\n');
}

/** Sort + draft for one contact. Returns the tool input object. */
export async function classifyAndDraft(channel, msgs, { name, contact }) {
  if (config.mockClaude) return mockClassify(msgs, channel);
  const system = [
    { type: 'text', text: RULES.replaceAll('{OWNER}', channel.owner_name) },
    { type: 'text', text: `BUSINESS KNOWLEDGE\n\n${knowledgeFor(channel)}`, cache_control: { type: 'ephemeral' } },
  ];
  const user = `Contact: ${name || 'unknown name'} (+${contact})\nConversation, oldest first; the last customer messages are the new ones:\n\n${fmtConversation(channel, msgs, name)}`;
  const json = await messagesApi({
    model: config.model, max_tokens: 1200, system,
    tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: user }],
  });
  const block = (json.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Claude returned no tool_use block');
  const r = block.input;
  if (!CATEGORIES[r.category]) r.category = 'other_business';
  if (r.category === 'machine_inquiry' || r.category === 'supplier') r.urgent = true;
  if (r.category === 'spam_ads' || r.category === 'personal') r.draft = '';
  return r;
}

/** Daily summary text (plain WhatsApp text, English). */
export async function dailySummary(channel, items, dateLabel) {
  if (config.mockClaude) return mockSummary(items, dateLabel);
  const lines = items.map((i) => `- [${i.status}${i.urgent ? ', URGENT' : ''}] ${CATEGORIES[i.category] || i.category}: ${i.name || '+' + i.contact}: ${i.summary}`).join('\n');
  const json = await messagesApi({
    model: config.model, max_tokens: 700,
    system: `Write ${channel.owner_name}'s daily WhatsApp summary in English. Plain text for WhatsApp (use *bold* sparingly, no markdown headers). Max 900 characters. Start with "Summary ${dateLabel}". Then: counts per category in one line; then "Still open" with urgent ones first (name + few words each, max 8 lines); then one line on what was handled. Never include personal messages or their content. Friendly, no filler.`,
    messages: [{ role: 'user', content: lines || 'No business messages today.' }],
  });
  return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
