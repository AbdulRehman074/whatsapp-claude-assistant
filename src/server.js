import http from 'node:http';
import { config } from './config.js';
import { db, getChannelBy, updateChannel, addPrivate, removePrivate, now, digits, token, getSetting, setSetting, addChannel, listChannels } from './db.js';
import { renderWizard, renderAdmin } from './admin.js';
import { classifyAndDraft, knowledgeTemplate } from './claude.js';
import { createSummaryTemplate } from './provider360.js';
import { sendSummary } from './engine.js';
import { parseWebhook, setWebhook } from './provider360.js';
import { handleEvents, draftItem, startLoops } from './engine.js';
import { renderInbox, renderPrivate, renderSetup, renderMachines, machinesCsv, renderTools } from './inbox.js';
import { handleMcpHttp } from './mcp.js';
import { broadcastRoute } from './broadcast.js';
import { getChannelByMcp } from './db.js';
import { ensureTopic, sendReminder } from './engine.js';

const MAX_BODY = 12 * 1024 * 1024; // contact imports can be large

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const parseForm = (s) => Object.fromEntries(new URLSearchParams(s));
const parseJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...extra });
  res.end(body);
}
const redirect = (res, to) => { res.writeHead(303, { location: to }); res.end(); };

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);

      if (url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');

      // --- Webhook: POST /webhook/<channelId>/<secret>
      if (parts[0] === 'webhook' && parts.length === 3) {
        const ch = getChannelBy('id', parts[1]);
        if (!ch || ch.webhook_secret !== parts[2]) return send(res, 404, 'not found', 'text/plain');
        if (req.method !== 'POST') return send(res, 200, 'ok', 'text/plain');
        const body = parseJson(await readBody(req));
        send(res, 200, 'ok', 'text/plain'); // answer fast; provider retries on slow responses
        try { handleEvents(ch, parseWebhook(body)); } catch (e) { console.error('webhook handling', e); }
        return;
      }

      // --- Claude connector (MCP): /mcp/<token>
      if (parts[0] === 'mcp' && parts.length === 2) {
        const ch = getChannelByMcp(parts[1]);
        if (!ch) return send(res, 404, 'not found', 'text/plain');
        const [status, body, headers] = handleMcpHttp(ch, req.method, req.method === 'POST' ? await readBody(req) : '');
        res.writeHead(status, { 'cache-control': 'no-store', ...headers });
        return res.end(body ?? '');
      }

      // --- One-time setup page: /setup/<setupToken>
      if (parts[0] === 'setup' && parts.length === 2) {
        const ch = getChannelBy('setup_token', parts[1]);
        if (!ch) return send(res, 404, 'Link not valid.', 'text/plain');
        if (req.method === 'POST') {
          if (ch.d360_api_key) return redirect(res, url.pathname);
          const key = String(parseForm(await readBody(req)).key || '').trim();
          if (key.length < 10) return send(res, 400, renderSetup(ch, { error: 'That does not look like an API key. Copy it again and paste it.' }));
          const hook = `${config.publicUrl}/webhook/${ch.id}/${ch.webhook_secret}`;
          try { await setWebhook(key, hook); }
          catch (e) { console.error('setWebhook', e.message); return send(res, 400, renderSetup(ch, { error: 'The key was not accepted by 360dialog. Check you copied the whole key and try again.' })); }
          updateChannel(ch.id, { d360_api_key: key });
          return redirect(res, url.pathname);
        }
        return send(res, 200, renderSetup(ch));
      }

      // --- Inbox: /inbox/<token>[/...]
      if (parts[0] === 'inbox' && parts[1]) {
        const ch = getChannelBy('inbox_token', parts[1]);
        if (!ch) return send(res, 404, 'Link not valid.', 'text/plain');
        const sub = parts.slice(2);
        if (!sub.length) {
          if (!ch.inbox_revealed) updateChannel(ch.id, { inbox_revealed: 1 });
          return send(res, 200, renderInbox(ch));
        }
        if (sub[0] === 'version') {
          const v = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM items WHERE channel_id = ?').get(ch.id);
          return send(res, 200, `${v.n}-${v.m}`, 'text/plain');
        }
        if (sub[0] === 'machines' || sub[0] === 'machines.csv') {
          const days = [7, 30, 90, 365].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
          const q = String(url.searchParams.get('q') || '').slice(0, 80);
          if (sub[0] === 'machines.csv') return send(res, 200, machinesCsv(ch, { days, q }), 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="machines-asked-for.csv"' });
          return send(res, 200, renderMachines(ch, { days, q }));
        }
        if (sub[0] === 'broadcast') {
          const out = await broadcastRoute(ch, req.method, sub.slice(1), url.searchParams, req.method === 'POST' ? await readBody(req) : '');
          if (typeof out === 'string') return redirect(res, out);
          return send(res, out[0], out[1], out[2]);
        }
        if (sub[0] === 'tools') {
          ensureTopic(ch);
          if (req.method === 'POST' && sub[1] === 'test') {
            try {
              const r = await sendReminder(ch, { force: true });
              if (r.skipped) await (await import('./engine.js')).pushNotify(ch, { title: 'Test reminder', body: 'Reminders work. Nobody is waiting for an answer right now.', click: `${config.publicUrl}/inbox/${ch.inbox_token}` });
              return send(res, 200, renderTools(ch, 'Test sent. Did a notification arrive on your phone?'));
            } catch (e) { return send(res, 200, renderTools(ch, 'Could not send: ' + e.message)); }
          }
          if (req.method === 'POST' && sub[1] === 'save') {
            const f = parseForm(await readBody(req));
            const times = String(f.remind_times || '').split(',').map((x) => x.trim()).filter((x) => /^\d\d:\d\d$/.test(x)).join(',');
            const hrs = Math.max(0, Math.min(72, Number(f.remind_after_hours) || 0));
            updateChannel(ch.id, { remind_times: times, remind_after_hours: hrs });
            return send(res, 200, renderTools(getChannelBy('id', ch.id), times ? `Saved. Reminders at ${times.replace(/,/g, ', ')}.` : 'Saved. Reminders are off (no times).'));
          }
          return send(res, 200, renderTools(ch));
        }
        if (sub[0] === 'private') {
          if (req.method === 'POST' && sub[1] === 'remove') { removePrivate(ch.id, parseForm(await readBody(req)).phone); return redirect(res, `/inbox/${ch.inbox_token}/private`); }
          if (req.method === 'POST') {
            const phones = String(parseForm(await readBody(req)).phones || '').split(/[,;\n]+/).map(digits).filter((p) => p.length >= 8);
            phones.forEach((p) => addPrivate(ch.id, p));
            return send(res, 200, renderPrivate(ch, `${phones.length} number(s) added.`));
          }
          return send(res, 200, renderPrivate(ch));
        }
        if (sub[0] === 'item' && sub[1] && req.method === 'POST') {
          const item = db.prepare('SELECT * FROM items WHERE id = ? AND channel_id = ?').get(Number(sub[1]), ch.id);
          if (!item) return send(res, 404, '{}', 'application/json');
          const data = parseJson(await readBody(req));
          const act = sub[2];
          if (act === 'save') db.prepare('UPDATE items SET draft = ? WHERE id = ?').run(String(data.draft ?? item.draft), item.id);
          else if (act === 'done') db.prepare("UPDATE items SET status = 'done', done_reason = 'done', updated_at = ? WHERE id = ?").run(now(), item.id);
          else if (act === 'private') addPrivate(ch.id, item.contact);
          else if (act === 'business' || act === 'redo') {
            db.prepare("UPDATE items SET status = 'pending', updated_at = ? WHERE id = ?").run(now(), item.id);
            const fresh = db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
            await draftItem(ch, fresh);
            if (act === 'business') {
              const r = db.prepare('SELECT category FROM items WHERE id = ?').get(item.id);
              if (r?.category === 'personal') db.prepare("UPDATE items SET status = 'open', category = 'other_business', updated_at = ? WHERE id = ?").run(now(), item.id);
            }
          } else return send(res, 400, '{}', 'application/json');
          return send(res, 200, '{"ok":true}', 'application/json');
        }
      }

      // --- First-run wizard at /
      if (url.pathname === '/') {
        const existing = getSetting('admin_token');
        if (existing) return send(res, 200, '<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:20px">This WhatsApp assistant is set up. Use your admin link or inbox link.</p>');
        if (req.method === 'POST') {
          const f = parseForm(await readBody(req));
          const owner = String(f.owner || '').trim().slice(0, 40);
          if (!owner) return send(res, 400, renderWizard());
          const adm = token();
          setSetting('admin_token', adm);
          addChannel({ id: 'number1', label: String(f.label || 'Number 1').slice(0, 60), ownerName: owner, summaryTo: f.summary_to,
            summaryTime: /^\d\d:\d\d$/.test(f.summary_time || '') ? f.summary_time : '18:00', knowledgeText: knowledgeTemplate() });
          return redirect(res, `/admin/${adm}?welcome=1`);
        }
        return send(res, 200, renderWizard());
      }

      // --- Admin: /admin/<token>[/...]
      if (parts[0] === 'admin' && parts[1]) {
        const adm = getSetting('admin_token');
        if (!adm || parts[1] !== adm) return send(res, 404, 'not found', 'text/plain');
        const base = `/admin/${adm}`;
        if (parts.length === 2) return send(res, 200, renderAdmin(adm, { welcome: url.searchParams.has('welcome'), notice: url.searchParams.get('n') || '' }));
        if (req.method !== 'POST') return redirect(res, base);
        const f = parseForm(await readBody(req));
        const back = (msg, anchor = '') => redirect(res, `${base}?n=${encodeURIComponent(msg)}${anchor ? '#' + anchor : ''}`);
        if (parts[2] === 'add') {
          const id = `number${listChannels().length + 1}`;
          addChannel({ id, label: String(f.label || id).slice(0, 60), ownerName: String(f.owner || 'Owner').slice(0, 40), knowledgeText: knowledgeTemplate() });
          return back('Number added. Send its setup link to the person who uses it.', id);
        }
        if (parts[2] === 'ch' && parts[3]) {
          const ch = getChannelBy('id', parts[3]);
          if (!ch) return back('Unknown number.');
          const act = parts[4];
          if (act === 'knowledge') { updateChannel(ch.id, { knowledge_text: String(f.knowledge || '').slice(0, 200000) }); return back('Knowledge saved. It is used from the next message.', ch.id); }
          if (act === 'summary') {
            const t = /^\d\d:\d\d$/.test(f.summary_time || '') ? f.summary_time : '18:00';
            updateChannel(ch.id, { summary_to: digits(f.summary_to) || null, summary_time: t });
            if (digits(f.summary_to) && ch.display_number && digits(f.summary_to) === ch.display_number) return back('The summary number must be a different number than the connected one. Please change it.', ch.id);
            return back('Summary settings saved.', ch.id);
          }
          if (act === 'template') {
            try { await createSummaryTemplate(ch.d360_api_key, ch.summary_template, ch.summary_template_lang); return back('Template submitted. WhatsApp usually approves it within minutes to 24 hours.', ch.id); }
            catch (e) { console.error(e.message); return back(/exist/i.test(e.message) ? 'The template already exists. Nothing to do.' : 'Could not submit the template: ' + e.message.slice(0, 160), ch.id); }
          }
          if (act === 'send-summary') {
            try { const r = await sendSummary(ch, { force: true }); return back(r.skipped ? 'Not sent: ' + r.skipped : 'Summary sent. Check WhatsApp.', ch.id); }
            catch (e) { return back('Summary not sent: ' + e.message.slice(0, 160) + ' (Is the template approved yet?)', ch.id); }
          }
          if (act === 'drafts') { updateChannel(ch.id, { drafts_enabled: ch.drafts_enabled ? 0 : 1 }); return back(ch.drafts_enabled ? 'Reply drafts switched off.' : 'Reply drafts switched on.', ch.id); }
          if (act === 'new-inbox') { updateChannel(ch.id, { inbox_token: token(), inbox_revealed: 0 }); return back('New inbox link created. The owner opens the setup link again to get it.', ch.id); }
          if (act === 'test') {
            const sample = 'Hello, is the machine from your advert still available? What is your best price and can you deliver to Belgium?';
            try {
              const result = await classifyAndDraft(ch, [{ direction: 'in', text: sample, ts: Date.now() }], { name: 'Test customer', contact: '32400000000' });
              return send(res, 200, renderAdmin(adm, { testResult: { sample, result } }));
            } catch (e) { return back('Test failed: ' + e.message.slice(0, 200)); }
          }
        }
        return back('Unknown action.');
      }
      send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, 'error', 'text/plain');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(config.port, () => {
    console.log(`WhatsApp assistant on :${config.port} (${config.mockClaude ? 'MOCK Claude' : config.model})${config.dryRunSend ? ' DRY_RUN_SEND' : ''}`);
    if (!config.anthropicKey && !config.mockClaude) console.warn('WARNING: ANTHROPIC_API_KEY is empty - drafts will fail.');
  });
  startLoops();
}
