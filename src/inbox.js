import { db, recentMessages, listPrivate, listRequests, ensureMcpToken } from './db.js';
import { CATEGORIES } from './claude.js';
import { config } from './config.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LANGS = { en: 'English', nl: 'Dutch', fr: 'French', es: 'Spanish', de: 'German', ar: 'Arabic', it: 'Italian', pl: 'Polish', pt: 'Portuguese', tr: 'Turkish' };

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'short' });
}

function waitFor(ts) {
  const h = (Date.now() - ts) / 3600000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
}
export const navFor = (ch, here) => `<nav>${[['', 'Waiting'], ['/machines', 'Machines'], ['/broadcast', 'Broadcast'], ['/tools', 'Reminders & Claude'], ['/private', 'Private']]
  .map(([p, l]) => `<a href="/inbox/${ch.inbox_token}${p}"${p === here ? ' style="text-decoration:underline"' : ''}>${l}</a>`).join('')}</nav>`;
export const head = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b7a4b"><title>${esc(title)}</title><style>${CSS}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.code{font:14px ui-monospace,Menlo,Consolas,monospace;background:var(--chip);border-radius:8px;padding:8px 10px;word-break:break-all}
form.row{flex-wrap:wrap}form.row input{min-width:0;flex:1 1 100%}td a,ul.plain a{color:var(--accent)}ol.steps{padding-left:22px}ol.steps li{margin:6px 0}</style></head><body>`;

export const CSS = `
:root{--bg:#f4f5f2;--card:#fff;--ink:#1d2320;--muted:#66706a;--line:#e2e5df;--accent:#0b7a4b;--accent-ink:#fff;--urgent:#b3261e;--urgent-bg:#fdeceb;--chip:#eef1ec;--warn-bg:#fff6dc;--warn:#7a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--card:#1b1f1c;--ink:#e8ece9;--muted:#9aa49e;--line:#2b312d;--accent:#3fbf7f;--accent-ink:#06130c;--urgent:#ff8a80;--urgent-bg:#3a1c1a;--chip:#252b27;--warn-bg:#352c10;--warn:#f1d27a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);padding:14px 16px 10px;border-bottom:1px solid var(--line)}
header h1{font-size:19px;margin:0}header p{margin:2px 0 0;color:var(--muted);font-size:14px}
header nav{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px}header a{color:var(--accent);text-decoration:none;font-weight:600}
main{max-width:680px;margin:0 auto;padding:12px 16px 80px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:22px 0 8px}
h2.urgent{color:var(--urgent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
.card.urgent{border-left:5px solid var(--urgent)}
.top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.who{font-weight:700;font-size:17px}.num{color:var(--muted);font-size:13px}.when{color:var(--muted);font-size:13px;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.chip{background:var(--chip);border-radius:99px;padding:2px 10px;font-size:13px}.chip.u{background:var(--urgent-bg);color:var(--urgent);font-weight:700}
.sum{margin:4px 0 10px}
details{margin:6px 0 10px;font-size:14px}summary{cursor:pointer;color:var(--accent);font-weight:600}
.msg{padding:6px 10px;border-radius:10px;margin:6px 0;max-width:92%;white-space:pre-wrap;word-wrap:break-word}
.msg.in{background:var(--chip)}.msg.out{background:var(--accent);color:var(--accent-ink);margin-left:auto}
.need{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:8px 10px;font-size:14px;margin-bottom:8px}
.err{background:var(--urgent-bg);color:var(--urgent);border-radius:10px;padding:8px 10px;font-size:13px;margin-bottom:8px}
textarea{width:100%;min-height:120px;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;background:var(--bg);color:var(--ink);resize:vertical}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
button,.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:10px 14px;font:inherit;font-size:15px;cursor:pointer;text-decoration:none}
.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:700;flex:1 1 100%;text-align:center}
.quiet{color:var(--muted)}
.empty{color:var(--muted);text-align:center;padding:30px 0}
form.row{display:flex;gap:8px;margin:10px 0}form.row input{flex:1;padding:10px;border-radius:10px;border:1px solid var(--line);font:inherit;background:var(--card);color:var(--ink)}
ul.plain{list-style:none;padding:0}ul.plain li{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
`;

function card(ch, it) {
  const msgs = recentMessages(ch.id, it.contact, 8);
  const needs = (() => { try { return JSON.parse(it.needs_info || '[]'); } catch { return []; } })();
  const personal = it.status === 'personal';
  const done = it.status === 'done';
  const chips = [
    it.urgent && !done ? '<span class="chip u">Urgent</span>' : '',
    it.category ? `<span class="chip">${esc(CATEGORIES[it.category] || it.category)}</span>` : '',
    it.language ? `<span class="chip">${esc(LANGS[it.language] || it.language)}</span>` : '',
    it.source === 'website_or_marketplace' ? '<span class="chip">Via website</span>' : '',
    done ? `<span class="chip">${{ replied: 'You replied', spam: 'Spam', no_reply_needed: 'No answer needed' }[it.done_reason] || 'Handled'}</span>` : '',
  ].join('');
  const convo = personal ? '' : `<details><summary>Show messages (${msgs.length})</summary>${msgs.map((m) => `<div class="msg ${m.direction}">${esc(m.text)}</div>`).join('')}</details>`;
  let body = '';
  if (personal) {
    body = `<div class="btns"><button data-act="private">Private: always skip</button><button data-act="business">It's business</button></div>`;
  } else if (!done && !ch.drafts_enabled) {
    body = `<div class="btns"><a class="btn primary" href="https://wa.me/${esc(it.contact)}">Open chat in WhatsApp</a>
        <button data-act="done">Handled</button><button data-act="private" class="quiet">Private</button></div>`;
  } else if (!done) {
    body = `${it.error ? `<div class="err">Draft failed: ${esc(it.error)}. Tap "Redo draft" or reply in WhatsApp.</div>` : ''}
      ${needs.length ? `<div class="need"><b>Check before sending:</b> ${needs.map(esc).join(' · ')}</div>` : ''}
      <textarea aria-label="Reply draft">${esc(it.draft)}</textarea>
      <div class="btns">
        <a class="btn primary" data-act="wa" href="#">Open in WhatsApp</a>
        <button data-act="copy">Copy</button><button data-act="done">Done</button>
        <button data-act="redo">Redo draft</button><button data-act="private" class="quiet">Private</button>
      </div>`;
  }
  return `<article class="card ${it.urgent && !done ? 'urgent' : ''}" data-id="${it.id}" data-phone="${esc(it.contact)}">
    <div class="top"><div><div class="who">${esc(it.name || 'Unknown')}</div><div class="num">+${esc(it.contact)}</div></div><div class="when">${!done && !personal ? `waiting ${waitFor(it.last_msg_ts)}` : ago(it.last_msg_ts)}</div></div>
    <div class="chips">${chips}</div><div class="sum">${esc(it.summary || '')}</div>${convo}${body}</article>`;
}

const SCRIPT = (token) => `
const T=${JSON.stringify(token)};
async function post(id,act,extra){const r=await fetch('/inbox/'+T+'/item/'+id+'/'+act,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(extra||{})});if(!r.ok)alert('Something went wrong, try again.');return r.ok}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-act]');if(!b)return;const c=b.closest('.card');const id=c.dataset.id;const ta=c.querySelector('textarea');const act=b.dataset.act;
 if(act==='wa'){e.preventDefault();const text=ta?ta.value:'';if(ta)post(id,'save',{draft:text});location.href='https://wa.me/'+c.dataset.phone+'?text='+encodeURIComponent(text);return}
 if(act==='copy'){try{await navigator.clipboard.writeText(ta.value);b.textContent='Copied'}catch{ta.select();document.execCommand('copy');b.textContent='Copied'}return}
 if(act==='private'&&!confirm('Mark this number private? It will be skipped from now on and what was stored about it is deleted.'))return;
 if(act==='redo'){b.textContent='Working…'}
 if(await post(id,act,ta?{draft:ta.value}:{}))location.reload()});
let v=null;setInterval(async()=>{if(document.activeElement&&document.activeElement.tagName==='TEXTAREA')return;try{const r=await fetch('/inbox/'+T+'/version');const t=await r.text();if(v&&t!==v)location.reload();v=t}catch{}},30000);
`;

export function renderInbox(ch) {
  const rows = db.prepare(`SELECT * FROM items WHERE channel_id = ? AND (status IN ('open','pending','personal') OR (status = 'done' AND updated_at > ?))
                           ORDER BY urgent DESC, last_msg_ts DESC`).all(ch.id, Date.now() - 24 * 3600 * 1000);
  const open = rows.filter((r) => r.status === 'open');
  const urgent = open.filter((r) => r.urgent);
  const other = open.filter((r) => !r.urgent);
  const pending = rows.filter((r) => r.status === 'pending');
  const personal = rows.filter((r) => r.status === 'personal');
  const done = rows.filter((r) => r.status === 'done');
  const section = (title, list, cls = '') => list.length ? `<h2 class="${cls}">${title} (${list.length})</h2>${list.map((r) => card(ch, r)).join('')}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b7a4b"><title>${esc(ch.label)}</title><style>${CSS}</style></head><body>
<header><h1>${esc(ch.label)}</h1><p>${open.length ? `${open.length} waiting for your answer (${urgent.length} urgent)` : 'Nobody waiting'}${pending.length ? ` · ${pending.length} new being read` : ''}</p>
${navFor(ch, '')}</header>
<main>${section('Urgent, waiting for your answer', urgent, 'urgent')}${section(urgent.length ? 'Also waiting' : 'Waiting for your answer', other)}
${pending.length ? `<h2>Being prepared (${pending.length})</h2>${pending.map((r) => `<div class="card"><div class="who">${esc(r.name || '+' + r.contact)}</div><div class="num">New message, ready in about a minute</div></div>`).join('')}` : ''}
${!open.length && !pending.length ? '<p class="empty">Nobody is waiting for an answer. All caught up.</p>' : ''}
${personal.length ? `<details><summary>Looks personal (${personal.length})</summary>${personal.map((r) => card(ch, r)).join('')}</details>` : ''}
${done.length ? `<details><summary>Handled in the last 24 hours (${done.length})</summary>${done.map((r) => card(ch, r)).join('')}</details>` : ''}
</main><script>${SCRIPT(ch.inbox_token)}</script></body></html>`;
}

export function renderPrivate(ch, msg = '') {
  const list = listPrivate(ch.id);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Private contacts</title><style>${CSS}</style></head><body><header><h1>Private contacts</h1><p>Messages from these numbers are never read, stored or sent to Claude.</p>
${navFor(ch, '/private')}</header><main>
${msg ? `<div class="need">${esc(msg)}</div>` : ''}
<form class="row" method="post" action="/inbox/${ch.inbox_token}/private"><input name="phones" placeholder="Numbers with country code, e.g. +31 6 1234 5678" required><button class="btn primary" style="flex:0 0 auto">Add</button></form>
<p class="quiet" style="font-size:14px">You can paste many numbers at once, separated by commas or new lines.</p>
<h2>${list.length} private numbers</h2><ul class="plain">${list.map((p) => `<li><span>+${esc(p.phone)}${p.note ? ` · ${esc(p.note)}` : ''}</span>
<form method="post" action="/inbox/${ch.inbox_token}/private/remove"><input type="hidden" name="phone" value="${esc(p.phone)}"><button>Remove</button></form></li>`).join('')}</ul>
</main></body></html>`;
}

export function renderSetup(ch, state = {}) {
  const connected = !!ch.d360_api_key;
  let body;
  if (!connected) {
    body = `<div class="card"><p>In 360dialog, open your number and click <b>Generate API key</b>. Copy the whole key and paste it below. It is saved only on your own server and never shown again.</p>
<form method="post"><textarea name="key" style="min-height:70px" placeholder="Paste the API key here" required></textarea>
<div class="btns"><button class="btn primary">Connect</button></div></form></div>`;
  } else if (!ch.inbox_revealed) {
    body = `<div class="card"><div class="who">Connected</div><p>New business messages on this number now appear in your private inbox with a reply draft.</p>
<a class="btn primary" href="/inbox/${ch.inbox_token}">Open my inbox</a>
<p class="quiet" style="font-size:14px">Open this on your phone, then in the browser menu choose <b>Add to Home screen</b>. This page shows the inbox link only once, until you open it.</p></div>`;
  } else {
    body = `<div class="card"><div class="who">Connected</div><p>This number is connected. The inbox link was already opened by its owner, so it is not shown here again. If it got lost, the admin can create a new inbox link.</p></div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Connect ${esc(ch.label)}</title><style>${CSS}</style></head><body><header><h1>Connect ${esc(ch.label)}</h1><p>WhatsApp assistant</p></header><main>
${state.error ? `<div class="err">${esc(state.error)}</div>` : ''}${body}</main></body></html>`;
}

// ---------- machines customers asked for ----------
export function machineRows(ch, days, q) {
  let rows = listRequests(ch.id, days ? Date.now() - days * 86400000 : 0);
  if (q) { const l = q.toLowerCase(); rows = rows.filter((r) => [r.machine, r.details, r.name, r.country, r.contact].join(' ').toLowerCase().includes(l)); }
  return rows;
}
const dstr = (ts) => new Date(ts).toLocaleDateString('en-GB', { timeZone: config.timezone, day: '2-digit', month: 'short', year: 'numeric' });

export function renderMachines(ch, { days = 30, q = '' } = {}) {
  const rows = machineRows(ch, days, q);
  const base = `/inbox/${ch.inbox_token}/machines`;
  const opt = (d, l) => `<option value="${d}"${Number(days) === d ? ' selected' : ''}>${l}</option>`;
  return `${head('Machines asked for')}<header><h1>Machines asked for</h1><p>Every machine customers asked about on WhatsApp</p>${navFor(ch, '/machines')}</header><main>
<form class="row" method="get" action="${base}"><input name="q" value="${esc(q)}" placeholder="Search: excavator, Komatsu, Spain…">
<select name="days" style="border-radius:10px;border:1px solid var(--line);padding:8px;font:inherit;background:var(--card);color:var(--ink)">${opt(7, '7 days')}${opt(30, '30 days')}${opt(90, '90 days')}${opt(365, '1 year')}</select>
<button>Show</button></form>
<p><a class="btn" href="${base}.csv?days=${days}&q=${encodeURIComponent(q)}">Download for Excel</a></p>
<h2>${rows.length} request(s)</h2>
${rows.length ? `<div class="card" style="padding:4px 8px;overflow-x:auto"><table><tr><th>Date</th><th>Machine</th><th>Customer</th></tr>
${rows.map((r) => `<tr><td style="white-space:nowrap">${esc(dstr(r.last_ts))}</td><td><b>${esc(r.machine)}</b>${r.details ? `<br><span class="quiet">${esc(r.details)}</span>` : ''}</td>
<td><a href="https://wa.me/${esc(r.contact)}">${esc(r.name || '+' + r.contact)}</a>${r.country ? `<br><span class="quiet">${esc(r.country)}</span>` : ''}</td></tr>`).join('')}</table></div>`
    : '<p class="empty">No machine requests yet in this period. New ones appear here automatically.</p>'}
</main></body></html>`;
}

export function machinesCsv(ch, { days = 30, q = '' } = {}) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Machine', 'Details', 'Customer', 'Phone', 'Country', 'First asked'].map(cell).join(';')];
  for (const r of machineRows(ch, days, q)) lines.push([dstr(r.last_ts), r.machine, r.details, r.name, '+' + r.contact, r.country, dstr(r.first_ts)].map(cell).join(';'));
  return '\ufeff' + lines.join('\r\n'); // BOM + semicolons: opens correctly in Dutch Excel
}

// ---------- reminders (ntfy) and the Claude connector ----------
export function renderTools(ch, msg = '') {
  const mcpUrl = `${config.publicUrl}/mcp/${ensureMcpToken(ch)}`;
  const base = `/inbox/${ch.inbox_token}/tools`;
  return `${head('Reminders & Claude')}<header><h1>Reminders & Claude</h1><p>Set up once on your phone</p>${navFor(ch, '/tools')}</header><main>
${msg ? `<div class="need">${esc(msg)}</div>` : ''}
<section class="card"><div class="who">1. Reminders on your phone</div>
<p>When customers are still waiting for your answer, your phone shows a notification with their names. Tap it to open this page.</p>
<ol class="steps"><li>Install the free app <b>ntfy</b> from the App Store (iPhone) or Play Store (Android).</li>
<li>Open it, tap <b>+</b>, and type this exact name as the topic:</li></ol>
<div class="code" id="topic">${esc(ch.ntfy_topic || '')}</div>
<div class="btns"><button data-copy="topic">Copy name</button></div>
<ol class="steps" start="3"><li>Tap <b>Subscribe</b> and allow notifications.</li><li>Tap the test button below. A notification should arrive within seconds.</li></ol>
<form method="post" action="${base}/test"><div class="btns"><button class="btn primary">Send a test reminder</button></div></form>
<form method="post" action="${base}/save">
<label style="display:block;font-weight:600;margin:14px 0 4px">Remind me at (Amsterdam time)</label>
<input name="remind_times" value="${esc(ch.remind_times || '')}" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);font:inherit;background:var(--card);color:var(--ink)">
<p class="quiet" style="font-size:14px;margin:4px 0">Times separated by commas, e.g. 09:00,13:00,17:00</p>
<label style="display:block;font-weight:600;margin:14px 0 4px">Only customers waiting longer than (hours)</label>
<input name="remind_after_hours" type="number" min="0" step="0.5" value="${esc(ch.remind_after_hours ?? 3)}" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);font:inherit;background:var(--card);color:var(--ink)">
<div class="btns"><button class="btn primary">Save reminder times</button></div></form>
<p class="quiet" style="font-size:14px">The topic name works like a password: keep it to yourself.</p></section>

<section class="card"><div class="who">2. Ask Claude about your WhatsApp</div>
<p>Connect your own Claude app once. After that you can ask Claude things like <i>"Check my WhatsApp"</i>, <i>"Who haven't I answered?"</i> or <i>"Which machines did customers ask for this month?"</i></p>
<ol class="steps"><li>On a computer, open <b>claude.ai</b> and log in.</li>
<li>Click your name (bottom left) → <b>Settings</b> → <b>Connectors</b>.</li>
<li>Click <b>Add custom connector</b>. Name: <b>WhatsApp Nedtrax</b>. URL: copy the link below.</li>
<li>Click <b>Add</b>. It now works in Claude on your computer and on your phone.</li></ol>
<div class="code" id="mcp">${esc(mcpUrl)}</div>
<div class="btns"><button data-copy="mcp">Copy link</button></div>
<p class="quiet" style="font-size:14px">This link gives access to your business chats. Do not share it. Claude can read, but never sends messages to customers.</p></section>
</main>
<script>document.addEventListener('click',async e=>{const b=e.target.closest('[data-copy]');if(!b)return;const t=document.getElementById(b.dataset.copy).textContent;
try{await navigator.clipboard.writeText(t)}catch{const r=document.createRange();r.selectNode(document.getElementById(b.dataset.copy));getSelection().removeAllRanges();getSelection().addRange(r);document.execCommand('copy')}b.textContent='Copied'});</script>
</body></html>`;
}
