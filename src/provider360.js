// 360dialog (WhatsApp Cloud API, coexistence) adapter.
// Incoming events use Meta's Cloud API webhook format, which 360dialog forwards:
//   field "messages"            -> customer messages + delivery statuses
//   field "smb_message_echoes"  -> messages Mounir sent from the WhatsApp Business app
// "history" and "smb_app_state_sync" events are ignored on purpose (we do not import old chats).
import { config } from './config.js';
import { digits } from './db.js';

function textOf(msg) {
  const t = msg.type;
  switch (t) {
    case 'text': return msg.text?.body || '';
    case 'image': return `[photo]${msg.image?.caption ? ' ' + msg.image.caption : ''}`;
    case 'video': return `[video]${msg.video?.caption ? ' ' + msg.video.caption : ''}`;
    case 'document': return `[document: ${msg.document?.filename || 'file'}]${msg.document?.caption ? ' ' + msg.document.caption : ''}`;
    case 'audio': return msg.audio?.voice ? '[voice note - listen in WhatsApp]' : '[audio file]';
    case 'sticker': return '[sticker]';
    case 'location': return `[location: ${msg.location?.name || ''} ${msg.location?.address || ''} ${msg.location?.latitude},${msg.location?.longitude}]`.replace(/\s+/g, ' ');
    case 'contacts': return `[contact card: ${(msg.contacts || []).map((c) => c.name?.formatted_name).join(', ')}]`;
    case 'button': return msg.button?.text || '[button]';
    case 'interactive': return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[interactive reply]';
    case 'reaction': return null; // ignore reactions
    case 'unsupported': return '[message type not supported by the API - open WhatsApp]';
    default: return `[${t}]`;
  }
}

/** Normalise a webhook body into a list of events. */
export function parseWebhook(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  if (body.event === 'history' || body.event === 'smb_app_state_sync') return out;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const display = digits(v.metadata?.display_phone_number);
      if (change.field === 'messages') {
        const names = Object.fromEntries((v.contacts || []).map((c) => [digits(c.wa_id), c.profile?.name || null]));
        for (const m of v.messages || []) {
          const text = textOf(m);
          if (text === null) continue;
          out.push({ kind: 'inbound', id: m.id, from: digits(m.from), name: names[digits(m.from)] || null,
            type: m.type, text, ts: Number(m.timestamp) * 1000 || Date.now(), display });
        }
        // statuses are ignored (delivery receipts of our own sends)
      } else if (change.field === 'smb_message_echoes') {
        for (const m of v.message_echoes || []) {
          const text = textOf(m);
          if (text === null) continue;
          out.push({ kind: 'echo', id: m.id, to: digits(m.to), type: m.type, text, ts: Number(m.timestamp) * 1000 || Date.now(), display });
        }
      }
    }
  }
  return out;
}

async function call(apiKey, method, path, body) {
  if (config.dryRunSend) {
    console.log(`[DRY_RUN_SEND] ${method} ${path}`, JSON.stringify(body));
    return { ok: true, dryRun: true };
  }
  const res = await fetch(`${config.d360Base}${path}`, {
    method,
    headers: { 'D360-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`360dialog ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

export const setWebhook = (apiKey, url) => call(apiKey, 'POST', '/v1/configs/webhook', { url });

export const sendText = (apiKey, to, body) => call(apiKey, 'POST', '/messages', {
  messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), type: 'text', text: { body, preview_url: true },
});

export const sendTemplate = (apiKey, to, name, lang, params) => call(apiKey, 'POST', '/messages', {
  messaging_product: 'whatsapp', to: digits(to), type: 'template',
  template: { name, language: { code: lang },
    components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] },
});

// Daily summary template (category UTILITY). Submitted once per number; Meta usually reviews it within minutes to 24 hours.
export const SUMMARY_TEMPLATE_TEXT = 'Your WhatsApp summary for {{1}}: {{2}} business chats today, {{3}} urgent still open. Customers waiting and details: {{4}}';
export const createSummaryTemplate = (apiKey, name = 'daily_summary', lang = 'en') => call(apiKey, 'POST', '/v1/configs/templates', {
  name, category: 'UTILITY', language: lang,
  components: [{ type: 'BODY', text: SUMMARY_TEMPLATE_TEXT,
    example: { body_text: [['11/11', '7', '2', 'https://example.sslip.io/inbox/abc']] } }],
});
