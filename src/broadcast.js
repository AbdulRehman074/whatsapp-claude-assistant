// Broadcast page: replaces the WhatsApp Business app broadcast lists, which WhatsApp makes read-only after coexistence.
// Contacts come from a vCard export of the owner's phone contacts (his names carry country and machine, e.g. "Cus Spain Komatsu PW180").
// A list is a set of keywords matched against contact names (or "+34"-style phone prefixes), minus manual exclusions.
// Messages go out one by one as an approved MARKETING template, so each customer gets a private message like a broadcast.
import { db, now, digits } from './db.js';
import { config } from './config.js';
import { esc, head, navFor } from './inbox.js';
import { call360 } from './provider360.js';

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  phone TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (channel_id, phone));
CREATE TABLE IF NOT EXISTS blists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', excluded TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS optouts (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, phone TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (channel_id, phone));
CREATE TABLE IF NOT EXISTS bsends (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  list_name TEXT, text TEXT, total INTEGER, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, status TEXT, last_error TEXT,
  created_at INTEGER NOT NULL, finished_at INTEGER);
`);

export const TEMPLATE_NAME = 'machine_update';
export const STOP_RE = /^\s*(stop|stopp|unsubscribe|arrêt|arret|baja|parar|afmelden|cancel)\s*[.!]?\s*$/i;
// Prefilled from the owner's existing broadcast lists (screenshot, Nov 2026). He edits keywords on the page.
const STARTER_LISTS = [
  ['Middle east', 'Syria, Jordan, Lebanon, Iraq, Saudi, UAE, Dubai, Qatar, Kuwait, Oman, Yemen, +963, +962, +961, +964, +966, +971, +974, +965, +968'],
  ['Spain', 'Spain, Espana, España, +34'], ['Nordic countries', 'Denmark, Sweden, Norway, Finland, Iceland, +45, +46, +47, +358'],
  ['Colombia guyana', 'Colombia, Guyana, +57, +592'], ['Maroc', 'Maroc, Morocco, Marokko, +212'], ['Greece', 'Greece, +30'],
  ['Africa', 'Africa'], ['Paraguay', 'Paraguay, +595'], ['Bolivia', 'Bolivia, +591'],
];

// ---------- contacts ----------
/** Parse a vCard (.vcf) export. Numbers without a country code are taken as Dutch. */
export function parseVcf(text) {
  const out = [];
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.split(/\r?\n/);
    const val = (re) => lines.find((l) => re.test(l))?.replace(/^[^:]*:/, '').trim();
    let name = val(/^FN[;:]/i);
    if (!name) { const n = val(/^N[;:]/i); if (n) name = n.split(';').filter(Boolean).reverse().join(' '); }
    const tels = lines.filter((l) => /^(item\d+\.)?TEL[;:]/i.test(l));
    const pick = tels.find((l) => /CELL|IPHONE|MOBILE/i.test(l)) || tels[0];
    if (!pick || !name) continue;
    const raw = pick.replace(/^[^:]*:/, '').replace(/^tel:/i, '').trim();
    let d = digits(raw);
    if (raw.trim().startsWith('+')) { /* already international */ } else if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '31' + d.slice(1);
    if (d.length < 8 || d.length > 15) continue;
    out.push({ phone: d, name: name.replace(/\\,/g, ',').replace(/\\;/g, ';').slice(0, 120) });
  }
  return out;
}
export function importContacts(channelId, list) {
  const ins = db.prepare('INSERT INTO contacts (channel_id, phone, name) VALUES (?,?,?) ON CONFLICT(channel_id, phone) DO UPDATE SET name = excluded.name');
  db.exec('BEGIN'); try { for (const c of list) ins.run(channelId, c.phone, c.name); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return list.length;
}
const contactCount = (chId) => db.prepare('SELECT COUNT(*) n FROM contacts WHERE channel_id = ?').get(chId).n;

// ---------- lists ----------
export function ensureStarterLists(chId) {
  if (db.prepare('SELECT 1 FROM blists WHERE channel_id = ?').get(chId)) return;
  const ins = db.prepare('INSERT INTO blists (channel_id, name, keywords, created_at) VALUES (?,?,?,?)');
  STARTER_LISTS.forEach(([n, k]) => ins.run(chId, n, k, now()));
}
const kwList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
export function members(chId, list) {
  const kws = kwList(list.keywords);
  if (!kws.length) return [];
  const excluded = new Set(JSON.parse(list.excluded || '[]'));
  const opted = new Set(db.prepare('SELECT phone FROM optouts WHERE channel_id = ?').all(chId).map((r) => r.phone));
  const priv = new Set(db.prepare('SELECT phone FROM private_contacts WHERE channel_id = ?').all(chId).map((r) => r.phone));
  const words = kws.filter((k) => !k.startsWith('+')).map((k) => k.toLowerCase());
  const prefixes = kws.filter((k) => k.startsWith('+')).map(digits).filter(Boolean);
  return db.prepare('SELECT phone, name FROM contacts WHERE channel_id = ? ORDER BY name').all(chId)
    .filter((c) => words.some((w) => c.name.toLowerCase().includes(w)) || prefixes.some((p) => c.phone.startsWith(p)))
    .map((c) => ({ ...c, excluded: excluded.has(c.phone), optedOut: opted.has(c.phone), private: priv.has(c.phone) }));
}
export const recipients = (chId, list) => members(chId, list).filter((m) => !m.excluded && !m.optedOut && !m.private);
export const getList = (chId, id) => db.prepare('SELECT * FROM blists WHERE channel_id = ? AND id = ?').get(chId, Number(id));

export function optOut(chId, phone) {
  db.prepare('INSERT OR IGNORE INTO optouts (channel_id, phone, ts) VALUES (?,?,?)').run(chId, digits(phone), now());
}

// ---------- template + sending ----------
const flat = (s) => String(s || '').replace(/\s*\n\s*/g, ' · ').replace(/\t/g, ' ').replace(/ {4,}/g, '   ').trim();
export const templateBody = (ch) => `Nedtrax B.V.\n\n{{1}}\n\n${ch.owner_name}`;
export function createBroadcastTemplate(ch) {
  return call360(ch.d360_api_key, 'POST', '/v1/configs/templates', {
    name: TEMPLATE_NAME, category: 'MARKETING', language: 'en',
    components: [
      { type: 'BODY', text: templateBody(ch), example: { body_text: [['New in stock: Volvo EC220E excavator, 2018, 6,400 hours, EUR 79,500 excl. VAT. Photos and video on request.']] } },
      { type: 'FOOTER', text: 'Reply STOP to stop these messages' },
    ],
  });
}
export async function templateStatus(ch) {
  if (config.dryRunSend) return 'APPROVED';
  try {
    const r = await call360(ch.d360_api_key, 'GET', '/v1/configs/templates?limit=200');
    const t = (r.waba_templates || r.data || []).find((x) => x.name === TEMPLATE_NAME);
    return t ? String(t.status || 'unknown').toUpperCase() : 'MISSING';
  } catch (e) { return 'UNKNOWN'; }
}

const running = new Set();
export function startSend(ch, list, text) {
  const to = recipients(ch.id, list);
  const msg = flat(text).slice(0, 900);
  const id = Number(db.prepare('INSERT INTO bsends (channel_id, list_name, text, total, status, created_at) VALUES (?,?,?,?,?,?)')
    .run(ch.id, list.name, msg, to.length, 'sending', now()).lastInsertRowid);
  running.add(id);
  (async () => {
    let sent = 0, failed = 0, lastErr = null;
    for (const r of to) {
      try {
        await call360(ch.d360_api_key, 'POST', '/messages', { messaging_product: 'whatsapp', to: r.phone, type: 'template',
          template: { name: TEMPLATE_NAME, language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: msg }] }] } });
        sent++;
      } catch (e) { failed++; lastErr = e.message.slice(0, 300); }
      db.prepare('UPDATE bsends SET sent = ?, failed = ?, last_error = ? WHERE id = ?').run(sent, failed, lastErr, id);
      if (!config.dryRunSend) await new Promise((res) => setTimeout(res, 120));
    }
    db.prepare("UPDATE bsends SET status = 'done', finished_at = ? WHERE id = ?").run(now(), id);
    running.delete(id);
    console.log(new Date().toISOString(), `broadcast ${id} to "${list.name}": ${sent} sent, ${failed} failed`);
  })();
  return { id, total: to.length };
}
export const isSending = () => running.size > 0;

// ---------- pages ----------
const input = 'width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);font:inherit;background:var(--card);color:var(--ink)';

export async function renderBroadcast(ch, { msg = '', listId = null } = {}) {
  ensureStarterLists(ch.id);
  const base = `/inbox/${ch.inbox_token}/broadcast`;
  const lists = db.prepare('SELECT * FROM blists WHERE channel_id = ? ORDER BY name COLLATE NOCASE').all(ch.id);
  const nContacts = contactCount(ch.id);
  const sends = db.prepare('SELECT * FROM bsends WHERE channel_id = ? ORDER BY id DESC LIMIT 8').all(ch.id);
  const status = ch.d360_api_key ? await templateStatus(ch) : 'NOT CONNECTED';
  const sel = listId ? getList(ch.id, listId) : null;

  const templateCard = status === 'APPROVED' ? '' : `<section class="card"><div class="who">One-time: message format</div>
<p>WhatsApp has to approve the broadcast message format once. ${status === 'MISSING' ? 'Tap the button to submit it.' : `Status: <b>${esc(status)}</b>. Approval takes minutes up to 24 hours.`}</p>
${status === 'MISSING' ? `<form method="post" action="${base}/template"><div class="btns"><button class="btn primary">Submit message format</button></div></form>` : ''}</section>`;

  const contactsCard = `<section class="card"><div class="who">Your contacts: ${nContacts}</div>
<p>${nContacts ? 'To update them, import again. Existing contacts are updated, nothing is lost.' : 'Import your phone contacts once. Your lists are built from the names you gave them (country, machine).'}</p>
<details${nContacts ? '' : ' open'}><summary>How to export contacts on iPhone</summary><ol class="steps">
<li>Open the <b>Contacts</b> app and tap <b>Lists</b> (top left).</li><li>Press and hold <b>All Contacts</b>, tap <b>Export</b>, then <b>Save to Files</b>.</li>
<li>Come back here, tap the button below and choose that file.</li></ol>
<p class="quiet">Android: Contacts → menu → Export → .vcf file.</p></details>
<input type="file" id="vcf" accept=".vcf,text/vcard,text/x-vcard" style="margin:8px 0">
<div class="btns"><button class="btn primary" id="up">Import contacts</button></div><p id="upmsg" class="quiet"></p></section>`;

  const listCards = lists.map((l) => { const m = members(ch.id, l); const r = m.filter((x) => !x.excluded && !x.optedOut && !x.private).length;
    return `<li><a href="${base}?list=${l.id}"><b>${esc(l.name)}</b></a><span class="quiet">${r} customer${r === 1 ? '' : 's'}</span></li>`; }).join('');

  let detail = '';
  if (sel) {
    const m = members(ch.id, sel); const r = m.filter((x) => !x.excluded && !x.optedOut && !x.private);
    detail = `<section class="card" id="send"><div class="who">${esc(sel.name)}: ${r.length} customer${r.length === 1 ? '' : 's'}</div>
${status === 'APPROVED' && r.length ? `<form method="post" action="${base}/send" onsubmit="return confirm('Send this to ${r.length} customers on ${esc(sel.name).replace(/'/g, '')}? WhatsApp charges a few cents per message.')">
<input type="hidden" name="list" value="${sel.id}">
<label style="display:block;font-weight:600;margin:8px 0 4px">Message</label>
<textarea name="text" required maxlength="900" placeholder="New in stock: ... Price ... Photos and video on request."></textarea>
<p class="quiet" style="font-size:14px">Customers see: "Nedtrax B.V." · your text · "${esc(ch.owner_name)}". A link to photos or the advert works. Line breaks become " · " (WhatsApp rule).</p>
${r.length > 250 ? '<div class="need">WhatsApp lets a new business number start up to 250 different customers per day. Until Nedtrax is verified in 360dialog, customers above that limit may fail. They show as "failed" below.</div>' : ''}
<div class="btns"><button class="btn primary">Send to ${r.length} customer${r.length === 1 ? '' : 's'}</button></div></form>` : (r.length ? '<p class="quiet">Sending opens as soon as WhatsApp approves the message format (see above).</p>' : '')}
<form method="post" action="${base}/list/${sel.id}">
<label style="display:block;font-weight:600;margin:12px 0 4px">List name</label><input name="name" value="${esc(sel.name)}" style="${input}">
<label style="display:block;font-weight:600;margin:12px 0 4px">Contacts whose name contains (or number starts with)</label>
<input name="keywords" value="${esc(sel.keywords)}" style="${input}"><p class="quiet" style="font-size:14px;margin:4px 0">Comma separated, e.g. <i>Spain, Komatsu, +34</i></p>
<details><summary>Who is on this list (${m.length}). Untick to leave someone out</summary>
${m.map((c) => `<label style="display:flex;gap:8px;padding:4px 0"><input type="checkbox" name="keep" value="${esc(c.phone)}"${c.excluded ? '' : ' checked'}${c.optedOut || c.private ? ' disabled' : ''}>
<span>${esc(c.name)} <span class="quiet">+${esc(c.phone)}${c.optedOut ? ' · said STOP' : ''}${c.private ? ' · private' : ''}</span></span></label>`).join('') || '<p class="quiet">Nobody matches yet. Import contacts or change the words.</p>'}
<input type="hidden" name="all" value="${esc(m.map((c) => c.phone).join(','))}"></details>
<div class="btns"><button class="btn primary">Save list</button></div></form>
<form method="post" action="${base}/list/${sel.id}/delete" onsubmit="return confirm('Delete this list? Contacts are not deleted.')"><div class="btns"><button class="quiet">Delete list</button></div></form></section>`;
  }

  return `${head('Broadcast')}<header><h1>Broadcast</h1><p>Send new machines to a whole list. Each customer gets a private message.</p>${navFor(ch, '/broadcast')}</header><main>
${msg ? `<div class="need">${esc(msg)}</div>` : ''}${detail}${templateCard}
<h2>Your lists</h2><div class="card"><ul class="plain">${listCards}</ul>
<form method="post" action="${base}/list/new" class="row"><input name="name" placeholder="New list, e.g. Komatsu buyers" required><button>Add</button></form></div>
${sends.length ? `<h2>Sent</h2><div class="card"><ul class="plain">${sends.map((s) => `<li><span><b>${esc(s.list_name)}</b> · ${new Date(s.created_at).toLocaleString('en-GB', { timeZone: config.timezone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}<br><span class="quiet">${esc(String(s.text).slice(0, 60))}</span></span>
<span class="quiet" title="${esc(s.last_error || '')}">${s.status === 'sending' ? 'sending… ' : ''}${s.sent}/${s.total} sent${s.failed ? `, ${s.failed} failed` : ''}</span></li>`).join('')}</ul></div>` : ''}
${contactsCard}
</main><script>
document.getElementById('up').onclick=async()=>{const f=document.getElementById('vcf').files[0];const m=document.getElementById('upmsg');if(!f){m.textContent='Choose the contacts file first.';return}
m.textContent='Importing…';let t=await f.text();t=t.replace(/^PHOTO[^\\n]*(\\r?\\n[ \\t][^\\n]*)*/gmi,'');
const r=await fetch('${base}/import',{method:'POST',headers:{'content-type':'text/plain'},body:t});m.textContent=await r.text();setTimeout(()=>location.reload(),1500)};
${sends.some((s) => s.status === 'sending') ? 'setTimeout(()=>location.reload(),4000);' : ''}
</script></body></html>`;
}

/** Handle /inbox/<token>/broadcast[/...]. Returns [status, html|text, type?] or a redirect path string. */
export async function broadcastRoute(ch, method, sub, query, bodyText) {
  const base = `/inbox/${ch.inbox_token}/broadcast`;
  const form = () => new URLSearchParams(bodyText);
  if (method === 'GET') return [200, await renderBroadcast(ch, { listId: query.get('list'), msg: query.get('n') || '' })];
  const back = (n, list) => `${base}?${list ? `list=${list}&` : ''}n=${encodeURIComponent(n)}${list ? '#send' : ''}`;
  if (sub[0] === 'import') {
    const list = parseVcf(bodyText);
    if (!list.length) return [400, 'No contacts found in that file. Export again as .vcf and try once more.', 'text/plain; charset=utf-8'];
    importContacts(ch.id, list);
    return [200, `${list.length} contacts imported.`, 'text/plain; charset=utf-8'];
  }
  if (sub[0] === 'template') {
    try { await createBroadcastTemplate(ch); return back('Submitted. WhatsApp usually approves it within minutes, sometimes up to 24 hours.'); }
    catch (e) { return back(/exist/i.test(e.message) ? 'The message format already exists. Waiting for WhatsApp approval.' : 'Could not submit: ' + e.message.slice(0, 160)); }
  }
  if (sub[0] === 'list' && sub[1] === 'new') {
    const name = String(form().get('name') || '').trim().slice(0, 60);
    if (!name) return back('Give the list a name.');
    const id = db.prepare('INSERT INTO blists (channel_id, name, keywords, created_at) VALUES (?,?,?,?)').run(ch.id, name, name, now()).lastInsertRowid;
    return back('List added. Check the words below, then save.', id);
  }
  if (sub[0] === 'list' && sub[1]) {
    const l = getList(ch.id, sub[1]);
    if (!l) return back('List not found.');
    if (sub[2] === 'delete') { db.prepare('DELETE FROM blists WHERE id = ?').run(l.id); return back(`List "${l.name}" deleted.`); }
    const f = form();
    const all = String(f.get('all') || '').split(',').filter(Boolean);
    const keep = new Set(f.getAll('keep'));
    const prevEx = new Set(JSON.parse(l.excluded || '[]'));
    // People not shown in this form (new keyword matches) keep their previous state.
    const excluded = [...new Set([...[...prevEx].filter((p) => !all.includes(p)), ...all.filter((p) => !keep.has(p))])];
    const kwChanged = String(f.get('keywords') ?? l.keywords).trim() !== l.keywords;
    db.prepare('UPDATE blists SET name = ?, keywords = ?, excluded = ? WHERE id = ?')
      .run(String(f.get('name') || l.name).trim().slice(0, 60), String(f.get('keywords') ?? l.keywords).trim().slice(0, 500), JSON.stringify(kwChanged ? [...prevEx] : excluded), l.id);
    return back('List saved.', l.id);
  }
  if (sub[0] === 'send') {
    const f = form(); const l = getList(ch.id, f.get('list')); const text = String(f.get('text') || '').trim();
    if (!l || !text) return back('Choose a list and write a message.', l?.id);
    if (!ch.d360_api_key) return back('The number is not connected.', l.id);
    if (isSending()) return back('Another broadcast is still sending. Try again in a minute.', l.id);
    if ((await templateStatus(ch)) !== 'APPROVED') return back('The message format is not approved by WhatsApp yet.', l.id);
    const r = startSend(ch, l, text);
    return back(r.total ? `Sending to ${r.total} customers. You can follow it under "Sent".` : 'Nobody on this list.', l.id);
  }
  return back('Unknown action.');
}
