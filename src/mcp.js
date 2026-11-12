// Claude connector (remote MCP server, Streamable HTTP, JSON responses only).
// The owner adds   <PUBLIC_URL>/mcp/<channel.mcp_token>   once in Claude: Settings > Connectors > Add custom connector.
// After that he can ask his own Claude app things like "check my WhatsApp" or "which machines were asked for this month".
// The secret token in the URL is the access control, so the link must stay private.
import { db, now, digits, listRequests } from './db.js';
import { CATEGORIES } from './claude.js';
import { config } from './config.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DAY = 86400000;

const fmt = (ts) => new Date(ts).toLocaleString('en-GB', { timeZone: config.timezone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const waited = (ts) => { const h = (now() - ts) / 3600000; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`; };
const who = (r) => `${r.name || 'Unknown'} (+${r.contact})`;
const clampDays = (d, def = 30) => Math.min(365, Math.max(1, Number(d) || def));

function findContacts(ch, q) {
  const d = digits(q);
  if (d.length >= 6) return db.prepare('SELECT DISTINCT contact, name FROM items WHERE channel_id = ? AND contact LIKE ?').all(ch.id, `%${d}%`);
  return db.prepare('SELECT DISTINCT contact, name FROM items WHERE channel_id = ? AND lower(name) LIKE ? ORDER BY last_msg_ts DESC LIMIT 5')
    .all(ch.id, `%${String(q).toLowerCase()}%`);
}

const TOOLS = [
  {
    name: 'whatsapp_overview',
    title: 'WhatsApp overview',
    description: 'Start here for "check my WhatsApp". Shows customers still waiting for an answer (oldest first), today\'s and this week\'s business chats, and the newest machine requests. Covers the connected WhatsApp Business number; messages are kept 30 days.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run(ch) {
      const waiting = db.prepare("SELECT * FROM items WHERE channel_id = ? AND status = 'open' ORDER BY urgent DESC, last_msg_ts ASC").all(ch.id);
      const today = db.prepare("SELECT COUNT(*) n FROM items WHERE channel_id = ? AND last_msg_ts >= ? AND category NOT IN ('personal','spam_ads')").get(ch.id, now() - DAY).n;
      const week = db.prepare("SELECT COUNT(*) n FROM items WHERE channel_id = ? AND last_msg_ts >= ? AND category NOT IN ('personal','spam_ads')").get(ch.id, now() - 7 * DAY).n;
      const reqs = listRequests(ch.id, now() - 7 * DAY).slice(0, 15);
      return [
        `${ch.label}: ${waiting.length} customer(s) waiting for an answer, ${today} business chat(s) in the last 24 h, ${week} in the last 7 days.`,
        '', 'WAITING FOR AN ANSWER (oldest first, urgent on top):',
        ...(waiting.length ? waiting.map((i) => `- ${i.urgent ? '[URGENT] ' : ''}${who(i)}: ${i.summary || ''} | waiting ${waited(i.last_msg_ts)} | chat: https://wa.me/${i.contact}`) : ['- nobody, all answered']),
        '', 'MACHINES ASKED FOR IN THE LAST 7 DAYS:',
        ...(reqs.length ? reqs.map((r) => `- ${fmt(r.last_ts)} ${r.machine}${r.details ? ` (${r.details})` : ''} | ${who(r)}${r.country ? ', ' + r.country : ''}`) : ['- none']),
      ].join('\n');
    },
  },
  {
    name: 'list_waiting_customers',
    title: 'Customers waiting for an answer',
    description: 'Customers whose last message has not been answered yet, oldest first, with how long they have been waiting and a one-line summary. Use for reminders and "who did I forget".',
    inputSchema: { type: 'object', properties: { min_hours: { type: 'number', description: 'Only customers waiting at least this many hours. Default 0.' } } },
    annotations: { readOnlyHint: true },
    run(ch, a) {
      const rows = db.prepare("SELECT * FROM items WHERE channel_id = ? AND status = 'open' AND last_msg_ts <= ? ORDER BY last_msg_ts ASC")
        .all(ch.id, now() - (Number(a.min_hours) || 0) * 3600000);
      if (!rows.length) return 'Nobody is waiting for an answer.';
      return rows.map((i) => `- ${who(i)} | ${CATEGORIES[i.category] || i.category}${i.urgent ? ', URGENT' : ''} | waiting ${waited(i.last_msg_ts)} (last message ${fmt(i.last_msg_ts)}) | ${i.summary || ''} | https://wa.me/${i.contact}`).join('\n');
    },
  },
  {
    name: 'list_machine_requests',
    title: 'Machines customers asked for',
    description: 'Every machine customers asked about (or offered) on WhatsApp, newest first: date, machine, details they gave, customer, country. Kept for one year.',
    inputSchema: { type: 'object', properties: {
      days: { type: 'number', description: 'How many days back. Default 30.' },
      search: { type: 'string', description: 'Optional filter on machine, details, customer or country, e.g. "excavator", "Komatsu", "Spain".' } } },
    annotations: { readOnlyHint: true },
    run(ch, a) {
      const days = clampDays(a.days);
      let rows = listRequests(ch.id, now() - days * DAY);
      if (a.search) { const q = String(a.search).toLowerCase(); rows = rows.filter((r) => [r.machine, r.details, r.name, r.country, r.contact].join(' ').toLowerCase().includes(q)); }
      if (!rows.length) return `No machine requests in the last ${days} days${a.search ? ` matching "${a.search}"` : ''}.`;
      return [`${rows.length} machine request(s) in the last ${days} days:`,
        ...rows.map((r) => `- ${fmt(r.last_ts)} | ${r.machine}${r.details ? ` | ${r.details}` : ''} | ${who(r)}${r.country ? ' | ' + r.country : ''}`)].join('\n');
    },
  },
  {
    name: 'search_whatsapp',
    title: 'Search WhatsApp chats',
    description: 'Find business chats from the last 30 days by words in the messages, customer name or number, and/or type. Returns each matching customer with a summary and the matching lines. Use for "all inquiries from the last 30 days", "who asked about transport to Morocco", etc.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Words to look for (any language as the customer wrote it). Leave empty to list all chats in the period.' },
      days: { type: 'number', description: 'How many days back, max 30. Default 30.' },
      category: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Optional type filter, e.g. machine_inquiry.' } } },
    annotations: { readOnlyHint: true },
    run(ch, a) {
      const since = now() - Math.min(30, clampDays(a.days)) * DAY;
      const q = String(a.query || '').trim().toLowerCase();
      let items = db.prepare("SELECT * FROM items WHERE channel_id = ? AND last_msg_ts >= ? AND category NOT IN ('personal') ORDER BY last_msg_ts DESC").all(ch.id, since);
      if (a.category) items = items.filter((i) => i.category === a.category);
      const out = [];
      for (const i of items) {
        let hits = [];
        if (q) {
          hits = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND contact = ? AND ts >= ? AND lower(text) LIKE ? ORDER BY ts LIMIT 3')
            .all(ch.id, i.contact, since, `%${q}%`);
          const meta = [i.name, i.contact, i.summary].join(' ').toLowerCase();
          if (!hits.length && !meta.includes(q)) continue;
        }
        out.push(`- ${who(i)} | ${CATEGORIES[i.category] || i.category || 'new'} | ${i.status === 'open' ? 'WAITING for answer' : 'answered/closed'} | last ${fmt(i.last_msg_ts)} | ${i.summary || ''}` +
          hits.map((m) => `\n    ${m.direction === 'in' ? 'customer' : 'you'} ${fmt(m.ts)}: ${String(m.text).slice(0, 200)}`).join(''));
        if (out.length >= 60) { out.push('… more results, narrow the search'); break; }
      }
      return out.length ? `${out.length} chat(s):\n${out.join('\n')}` : 'No matching chats in that period.';
    },
  },
  {
    name: 'get_conversation',
    title: 'Read one WhatsApp conversation',
    description: 'The recent messages with one customer (last 30 days), found by phone number or name.',
    inputSchema: { type: 'object', properties: { customer: { type: 'string', description: 'Phone number (any format) or part of the name.' } }, required: ['customer'] },
    annotations: { readOnlyHint: true },
    run(ch, a) {
      const found = findContacts(ch, a.customer || '');
      if (!found.length) return `No customer found for "${a.customer}".`;
      if (found.length > 1 && digits(a.customer).length < 6) return `Several customers match: ${found.map(who).join(', ')}. Ask again with the number.`;
      const c = found[0];
      const msgs = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND contact = ? ORDER BY ts DESC LIMIT 40').all(ch.id, c.contact).reverse();
      return [`Conversation with ${who(c)} (https://wa.me/${c.contact}):`,
        ...msgs.map((m) => `${fmt(m.ts)} ${m.direction === 'in' ? (c.name || 'Customer') : 'You'}: ${m.text}`)].join('\n');
    },
  },
  {
    name: 'mark_handled',
    title: 'Mark a customer as handled',
    description: 'Take a customer off the waiting list, for example when the owner answered by phone. Does not send anything to the customer.',
    inputSchema: { type: 'object', properties: { customer: { type: 'string', description: 'Phone number or name.' } }, required: ['customer'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run(ch, a) {
      const found = findContacts(ch, a.customer || '');
      if (found.length !== 1) return found.length ? `Several customers match: ${found.map(who).join(', ')}. Use the number.` : `No customer found for "${a.customer}".`;
      const r = db.prepare("UPDATE items SET status = 'done', done_reason = 'done', updated_at = ? WHERE channel_id = ? AND contact = ? AND status IN ('open','pending')")
        .run(now(), ch.id, found[0].contact);
      return r.changes ? `${who(found[0])} is marked as handled.` : `${who(found[0])} was not on the waiting list.`;
    },
  },
];

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function handleRpc(ch, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'Invalid request');
  const isNote = msg.id === undefined || msg.id === null;
  if (isNote) return null; // notifications (initialized, cancelled, ...) need no answer
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return rpcResult(msg.id, {
        protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'whatsapp-assistant', title: `WhatsApp: ${ch.label}`, version: '1.1.0' },
        instructions: `This connector reads ${ch.owner_name}'s WhatsApp Business number (${ch.label}): customers waiting for an answer, business chats of the last 30 days and the machines customers asked for. It never sends messages to customers. For "check my WhatsApp" call whatsapp_overview first. Personal chats are not included. Times are ${config.timezone}.`,
      });
    case 'ping': return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
      try { return rpcResult(msg.id, { content: [{ type: 'text', text: tool.run(ch, p.arguments || {}) }] }); }
      catch (e) { console.error('mcp tool', p.name, e); return rpcResult(msg.id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    }
    case 'resources/list': return rpcResult(msg.id, { resources: [] });
    case 'prompts/list': return rpcResult(msg.id, { prompts: [] });
    default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** HTTP entry: returns [status, body|null, headers]. */
export function handleMcpHttp(ch, method, bodyText) {
  if (method === 'GET') return [405, null, { allow: 'POST' }]; // no server-to-client stream
  if (method === 'DELETE') return [200, null, {}];
  if (method !== 'POST') return [405, null, { allow: 'POST' }];
  let payload; try { payload = JSON.parse(bodyText || 'null'); } catch { return [400, JSON.stringify(rpcError(null, -32700, 'Parse error')), {}]; }
  const batch = Array.isArray(payload);
  const answers = (batch ? payload : [payload]).map((m) => handleRpc(ch, m)).filter(Boolean);
  if (!answers.length) return [202, null, {}];
  return [200, JSON.stringify(batch ? answers : answers[0]), { 'content-type': 'application/json' }];
}
