import { db, now, saveMessage, isPrivate, recentMessages, updateChannel, listChannels, purgeOld, digits, saveRequest, token } from './db.js';
import { classifyAndDraft, dailySummary } from './claude.js';
import { sendText, sendTemplate } from './provider360.js';
import { config } from './config.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Handle normalised webhook events for one channel. */
export function handleEvents(channel, events) {
  for (const e of events) {
    if (e.display && !channel.display_number) {
      updateChannel(channel.id, { display_number: e.display });
      channel.display_number = e.display;
    }
    if (e.kind === 'inbound') {
      // The owner writing to his own business number from his summary phone: just keeps the 24h window open.
      if (channel.summary_to && e.from === digits(channel.summary_to)) {
        updateChannel(channel.id, { owner_last_inbound: e.ts });
        continue;
      }
      if (isPrivate(channel.id, e.from)) continue; // private contact: never stored, never sent to Claude
      saveMessage({ id: e.id, channelId: channel.id, contact: e.from, direction: 'in', type: e.type, text: e.text, ts: e.ts });
      const open = db.prepare("SELECT * FROM items WHERE channel_id = ? AND contact = ? AND status IN ('pending','open','personal') ORDER BY id DESC LIMIT 1")
        .get(channel.id, e.from);
      if (open) {
        db.prepare("UPDATE items SET status = 'pending', last_msg_ts = ?, updated_at = ?, name = COALESCE(?, name), error = NULL WHERE id = ?")
          .run(e.ts, now(), e.name, open.id);
      } else {
        db.prepare("INSERT INTO items (channel_id, contact, name, status, last_msg_ts, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
          .run(channel.id, e.from, e.name, 'pending', e.ts, now(), now());
      }
    } else if (e.kind === 'echo') {
      // Mounir replied from the WhatsApp Business app.
      if (!e.to || isPrivate(channel.id, e.to)) continue;
      if (channel.summary_to && e.to === digits(channel.summary_to)) continue;
      saveMessage({ id: e.id, channelId: channel.id, contact: e.to, direction: 'out', type: e.type, text: e.text, ts: e.ts });
      db.prepare("UPDATE items SET status = 'done', done_reason = 'replied', updated_at = ? WHERE channel_id = ? AND contact = ? AND status IN ('open','pending')")
        .run(now(), channel.id, e.to);
    }
  }
}

let busy = false;
/** Draft items whose customer stopped typing DEBOUNCE_SECONDS ago. */
export async function processPending() {
  if (busy) return;
  busy = true;
  try {
    const cutoff = now() - config.debounceSeconds * 1000;
    const rows = db.prepare("SELECT i.*, c.owner_name FROM items i JOIN channels c ON c.id = i.channel_id WHERE i.status = 'pending' AND i.last_msg_ts <= ? ORDER BY i.last_msg_ts LIMIT 10").all(cutoff);
    for (const item of rows) {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(item.channel_id);
      await draftItem(channel, item);
    }
  } finally { busy = false; }
}

export async function draftItem(channel, item) {
  const msgs = recentMessages(channel.id, item.contact);
  if (!msgs.length) { db.prepare('DELETE FROM items WHERE id = ?').run(item.id); return; }
  try {
    const r = await classifyAndDraft(channel, msgs, { name: item.name, contact: item.contact });
    const status = r.category === 'personal' ? 'personal' : (r.category === 'spam_ads' || !r.needs_reply ? 'done' : 'open');
    const reason = r.category === 'spam_ads' ? 'spam' : (status === 'done' ? 'no_reply_needed' : null);
    db.prepare(`UPDATE items SET status = ?, category = ?, urgent = ?, language = ?, source = ?, summary = ?, draft = ?, needs_info = ?,
                done_reason = ?, error = NULL, updated_at = ? WHERE id = ?`)
      .run(status, r.category, r.urgent ? 1 : 0, r.language, r.source, r.summary, r.draft || '', JSON.stringify(r.needs_info || []),
        reason, now(), item.id);
    if (['machine_inquiry', 'supplier', 'existing_customer', 'other_business'].includes(r.category)) {
      for (const m of r.machines) saveRequest({ channelId: channel.id, contact: item.contact, name: item.name, country: r.country || null,
        machine: m.machine, details: m.details || null, ts: item.last_msg_ts || now() });
    }
    log(`drafted item ${item.id} (${channel.id}) -> ${r.category}${r.urgent ? ' URGENT' : ''} [${r.language}]`);
  } catch (err) {
    // Keep it visible in the inbox instead of losing it; retried on the next "Redo draft" tap.
    db.prepare("UPDATE items SET status = 'open', category = COALESCE(category,'other_business'), summary = COALESCE(summary,'New message (could not be read automatically, open WhatsApp)'), error = ?, updated_at = ? WHERE id = ?")
      .run(String(err.message).slice(0, 300), now(), item.id);
    log(`draft failed for item ${item.id}:`, err.message);
  }
}

// ---------- daily summary ----------
function localParts(ts = now()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, label: `${p.day}/${p.month}` };
}

export async function sendSummary(channel, { force = false } = {}) {
  const lp = localParts();
  if (!channel.summary_to || !channel.d360_api_key) return { skipped: 'no summary number or not connected' };
  const since = now() - 24 * 3600 * 1000;
  const items = db.prepare("SELECT * FROM items WHERE channel_id = ? AND category IS NOT NULL AND category NOT IN ('personal','spam_ads') AND (updated_at >= ? OR status = 'open') ORDER BY urgent DESC, last_msg_ts DESC")
    .all(channel.id, since);
  const open = items.filter((i) => i.status === 'open');
  const link = `${config.publicUrl}/inbox/${channel.inbox_token}`;
  const windowOpen = channel.owner_last_inbound && now() - channel.owner_last_inbound < 23.5 * 3600 * 1000;
  let mode;
  if (windowOpen) {
    const text = await dailySummary(channel, items, lp.label);
    await sendText(channel.d360_api_key, channel.summary_to, `${text}\n\nYour inbox: ${link}`);
    mode = 'text';
  } else {
    // Outside the 24h window WhatsApp only allows an approved template.
    await sendTemplate(channel.d360_api_key, channel.summary_to, channel.summary_template, channel.summary_template_lang,
      [lp.label, String(items.length), String(open.filter((i) => i.urgent).length), link]);
    mode = 'template';
  }
  if (!force) updateChannel(channel.id, { last_summary_date: lp.date });
  log(`summary sent for ${channel.id} via ${mode}`);
  return { mode, items: items.length };
}

export async function summaryTick() {
  const lp = localParts();
  for (const ch of listChannels()) {
    if (ch.summary_to && ch.d360_api_key && ch.last_summary_date !== lp.date && lp.hm >= (ch.summary_time || '18:00')) {
      try { await sendSummary(ch); } catch (e) { log(`summary failed for ${ch.id}:`, e.message); updateChannel(ch.id, { last_summary_date: lp.date }); }
    }
  }
}

// ---------- reminders (push notification through the free ntfy app) ----------
export async function pushNotify(channel, { title, body, click }) {
  if (!channel.ntfy_topic) return { skipped: 'no topic' };
  const url = `${config.ntfyBase}/${channel.ntfy_topic}`;
  if (config.dryRunSend) { log(`[DRY_RUN_SEND] push ${url}`, title, body); return { ok: true, dryRun: true, body }; }
  // HTTP headers must be plain ASCII; names with accents stay intact in the body.
  const res = await fetch(url, { method: 'POST', headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: 'bell', Priority: 'high', ...(click ? { Click: click } : {}) }, body });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  return { ok: true };
}

export function waitingItems(channel, minHours = 0) {
  return db.prepare("SELECT * FROM items WHERE channel_id = ? AND status = 'open' AND last_msg_ts <= ? ORDER BY urgent DESC, last_msg_ts ASC")
    .all(channel.id, now() - minHours * 3600 * 1000);
}
const waitLabel = (ts) => { const h = (now() - ts) / 3600000; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`; };

export async function sendReminder(channel, { force = false } = {}) {
  const list = waitingItems(channel, force ? 0 : (channel.remind_after_hours ?? 3));
  if (!list.length) return { skipped: 'nobody waiting' };
  const lines = list.slice(0, 8).map((i) => `• ${i.name || '+' + i.contact}: ${String(i.summary || '').slice(0, 70)} (${waitLabel(i.last_msg_ts)})`);
  if (list.length > 8) lines.push(`… and ${list.length - 8} more`);
  const title = `${list.length} customer${list.length > 1 ? 's' : ''} waiting for your answer`;
  return pushNotify(channel, { title, body: lines.join('\n'), click: `${config.publicUrl}/inbox/${channel.inbox_token}` });
}

export async function reminderTick() {
  const lp = localParts();
  for (const ch of listChannels()) {
    if (!ch.ntfy_topic) continue;
    const slots = String(ch.remind_times || '').split(',').map((x) => x.trim()).filter((x) => /^\d\d:\d\d$/.test(x)).sort();
    const due = slots.filter((x) => x <= lp.hm).pop();
    if (!due) continue;
    const key = `${lp.date} ${due}`;
    if (ch.last_remind_slot === key) continue;
    updateChannel(ch.id, { last_remind_slot: key });
    const [h, m] = due.split(':').map(Number); const [nh, nm] = lp.hm.split(':').map(Number);
    if ((nh * 60 + nm) - (h * 60 + m) > 30) continue; // server was asleep: skip old slots instead of sending late
    try { const r = await sendReminder(ch); log(`reminder ${ch.id} ${key}:`, r.skipped || 'sent'); } catch (e) { log(`reminder failed for ${ch.id}:`, e.message); }
  }
}
export const ensureTopic = (ch) => { if (!ch.ntfy_topic) { ch.ntfy_topic = `nedtrax-${token(15).replace(/[^A-Za-z0-9]/g, '')}`; updateChannel(ch.id, { ntfy_topic: ch.ntfy_topic }); } return ch.ntfy_topic; };

export function startLoops() {
  setInterval(() => processPending().catch((e) => log('processPending', e.message)), 10_000);
  setInterval(() => summaryTick().catch((e) => log('summaryTick', e.message)), 60_000);
  setInterval(() => reminderTick().catch((e) => log('reminderTick', e.message)), 60_000);
  setInterval(() => purgeOld(config.retentionDays), 3600_000);
  purgeOld(config.retentionDays);
}
