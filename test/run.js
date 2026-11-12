// End-to-end test with fake 360dialog webhooks. No network: MOCK_CLAUDE + DRY_RUN_SEND.
// Usage: npm test            (set REAL_CLAUDE=1 with ANTHROPIC_API_KEY to test real drafts)
import fs from 'node:fs';
import assert from 'node:assert/strict';

const dbFile = './data/test.db';
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
Object.assign(process.env, {
  DB_PATH: dbFile, MOCK_CLAUDE: process.env.REAL_CLAUDE === '1' ? '0' : '1', DRY_RUN_SEND: '1',
  DEBOUNCE_SECONDS: '0', PORT: '3999', PUBLIC_URL: 'http://localhost:3999',
});
const { createServer } = await import('../src/server.js');
const { addChannel, db, getChannelBy, addPrivate } = await import('../src/db.js');
const { processPending, sendSummary } = await import('../src/engine.js');

const server = createServer().listen(3999);
const base = 'http://localhost:3999';
const ch = addChannel({ id: 'mounir', label: 'Mounir · Nedtrax', ownerName: 'Mounir', summaryTo: '+31 6 9999 0000' });
const OWNER_NUM = '31600000001';
addPrivate('mounir', '31655555555', 'Family');

let n = 0;
const t = () => Math.floor(Date.now() / 1000) - 600 + (n++);
const inbound = (from, name, msg) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: OWNER_NUM, phone_number_id: 'PNID' },
  contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id: `wamid.${n}`, timestamp: String(t()), ...msg }] } }] }] });
const echo = (to, body) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'smb_message_echoes', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: OWNER_NUM, phone_number_id: 'PNID' },
  message_echoes: [{ from: OWNER_NUM, to, id: `wamid.e${n}`, timestamp: String(t()), type: 'text', text: { body } }] } }] }] });
const hook = (payload) => fetch(`${base}/webhook/mounir/${ch.webhook_secret}`, { method: 'POST', body: JSON.stringify(payload) });
const text = (body) => ({ type: 'text', text: { body } });

const cases = [
  ['31612340001', 'Jan de Vries', text('Goedemiddag, is de Volvo EC220 graafmachine nog beschikbaar? Wat is de prijs?')],
  ['33612340002', 'Pierre Martin', text('Bonjour, je vous contacte depuis l\'annonce https://example-machines.com/ad/12345. Quel est le prix du chargeur Caterpillar 950?')],
  ['34612340003', 'Carlos Ruiz', text('Hola, ¿todavía tienen el tractor John Deere? ¿Hacen envío a España?')],
  ['44712340004', 'Tom Baker', text('Hi, we offer 3 used forklifts for sale, Toyota 2019. Interested?')],
  ['31612340005', 'Transport BV', text('Hello, invoice 2026-114 for your machine is paid. When can we do the pickup?')],
  ['31612340006', 'SEO Pro', text('Get 50% discount on our marketing services, click here now!')],
  ['31655555555', 'Mama', text('Habibi, eten vanavond om 7?')],            // private list: must be dropped
  ['31612340008', 'Ahmed', text('Hey schat, dinner tonight with the family?')], // not on list: should land as personal
  ['31612340009', 'Unknown', { type: 'audio', audio: { voice: true, id: 'media1' } }],
];
for (const [from, name, msg] of cases) assert.equal((await hook(inbound(from, name, msg))).status, 200);
// a second message from Jan before drafting: must merge into one item
await hook(inbound('31612340001', 'Jan de Vries', text('En kan ik hem zaterdag komen bekijken?')));
// bad secret is rejected
assert.equal((await fetch(`${base}/webhook/mounir/wrong`, { method: 'POST', body: '{}' })).status, 404);

await processPending();
const items = db.prepare('SELECT * FROM items ORDER BY id').all();
const by = (p) => items.find((i) => i.contact === p);
assert.equal(items.length, 8, 'one item per non-private contact');
assert.ok(!db.prepare("SELECT 1 FROM messages WHERE contact = '31655555555'").get(), 'private contact never stored');
assert.equal(db.prepare("SELECT COUNT(*) c FROM messages WHERE contact = '31612340001'").get().c, 2);
if (process.env.REAL_CLAUDE !== '1') {
  assert.equal(by('31612340001').category, 'machine_inquiry'); assert.equal(by('31612340001').language, 'nl'); assert.equal(by('31612340001').urgent, 1);
  assert.equal(by('33612340002').language, 'fr'); assert.equal(by('33612340002').source, 'website_or_marketplace');
  assert.equal(by('34612340003').language, 'es');
  assert.equal(by('44712340004').category, 'supplier');
  assert.equal(by('31612340005').category, 'existing_customer');
  assert.equal(by('31612340006').status, 'done');
  assert.equal(by('31612340008').status, 'personal');
}
console.log('\nItems after drafting:');
for (const i of db.prepare('SELECT * FROM items ORDER BY urgent DESC, id').all())
  console.log(`  ${i.status.padEnd(8)} ${String(i.category).padEnd(18)} ${i.urgent ? 'URGENT' : '      '} ${String(i.language).padEnd(3)} ${i.name}: ${i.summary}\n     draft: ${(i.draft || '').replace(/\n/g, ' ').slice(0, 160)}`);

// Mounir replies to Pierre from the app -> item closes
await hook(echo('33612340002', 'Bonjour Pierre, oui elle est disponible.'));
assert.equal(db.prepare("SELECT status FROM items WHERE contact = '33612340002'").get().status, 'done');

// inbox page renders, and buttons work
const tok = ch.inbox_token;
const html = await (await fetch(`${base}/inbox/${tok}`)).text();
assert.ok(html.includes('Jan de Vries') && html.includes('Urgent'));
assert.ok(!html.includes('Mama') && !html.includes('eten vanavond'));
assert.equal((await fetch(`${base}/inbox/wrong-token`)).status, 404);
const carlos = by('34612340003');
assert.equal((await fetch(`${base}/inbox/${tok}/item/${carlos.id}/save`, { method: 'POST', body: JSON.stringify({ draft: 'Hola Carlos, sí.' }) })).status, 200);
assert.equal(db.prepare('SELECT draft FROM items WHERE id = ?').get(carlos.id).draft, 'Hola Carlos, sí.');
assert.equal((await fetch(`${base}/inbox/${tok}/item/${carlos.id}/done`, { method: 'POST', body: '{}' })).status, 200);
const ahmed = by('31612340008');
await fetch(`${base}/inbox/${tok}/item/${ahmed.id}/private`, { method: 'POST', body: '{}' });
assert.ok(!db.prepare("SELECT 1 FROM messages WHERE contact = '31612340008'").get(), 'marking private deletes stored data');
await hook(inbound('31612340008', 'Ahmed', text('Are you coming?')));
await processPending();
assert.ok(!db.prepare("SELECT 1 FROM items WHERE contact = '31612340008'").get(), 'private contact ignored afterwards');

// private list page: add numbers in bulk
const pr = await fetch(`${base}/inbox/${tok}/private`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'phones=' + encodeURIComponent('+31 6 1111 2222, +32 470 12 34 56') });
assert.ok((await pr.text()).includes('2 number(s) added'));

// setup page stores key (DRY_RUN_SEND fakes the 360dialog call)
assert.equal((await fetch(`${base}/setup/${ch.setup_token}`)).status, 200);
const sp = await fetch(`${base}/setup/${ch.setup_token}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'key=TEST_KEY_1234567890' });
assert.equal(sp.status, 303);
assert.equal(getChannelBy('id', 'mounir').d360_api_key, 'TEST_KEY_1234567890');

// summary: template outside the 24h window, plain text inside it
let r = await sendSummary(getChannelBy('id', 'mounir'), { force: true });
assert.equal(r.mode, 'template');
await hook(inbound('31699990000', 'Mounir', text('ok')));
assert.ok(!db.prepare("SELECT 1 FROM items WHERE contact = '31699990000'").get(), 'owner summary phone is not an inbox item');
r = await sendSummary(getChannelBy('id', 'mounir'), { force: true });
assert.equal(r.mode, 'text');

// first-run wizard + admin page
assert.ok((await (await fetch(`${base}/`)).text()).includes('Set up your WhatsApp assistant'));
const wz = await fetch(`${base}/`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'owner=Mounir&label=Number+1&summary_to=&summary_time=18:00' });
assert.equal(wz.status, 303);
const adminPath = wz.headers.get('location').split('?')[0];
assert.ok((await (await fetch(`${base}/`)).text()).includes('is set up'), 'wizard only runs once');
const adminHtml = await (await fetch(base + adminPath)).text();
assert.ok(adminHtml.includes('Setup link for this number') && adminHtml.includes('Business knowledge'));
assert.equal((await fetch(`${base}/admin/wrong`)).status, 404);
const n1 = getChannelBy('id', 'number1');
assert.ok(n1.knowledge_text.includes('Standard answers'));
await fetch(`${base}${adminPath}/ch/number1/knowledge`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'knowledge=' + encodeURIComponent('Nedtrax test knowledge') });
assert.equal(getChannelBy('id', 'number1').knowledge_text, 'Nedtrax test knowledge');
assert.ok((await (await fetch(`${base}${adminPath}/ch/number1/test`, { method: 'POST' })).text()).includes('Test draft'));
await fetch(`${base}${adminPath}/add`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'label=Colleague&owner=Sam' });
assert.ok(getChannelBy('id', 'number3') || getChannelBy('id', 'number2'), 'second number added');
// inbox link is shown on the setup page only until the owner opens it
await fetch(`${base}/setup/${n1.setup_token}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'key=TEST_KEY_ABCDEFGHIJ' });
assert.ok((await (await fetch(`${base}/setup/${n1.setup_token}`)).text()).includes(`/inbox/${n1.inbox_token}`));
await fetch(`${base}/inbox/${n1.inbox_token}`);
assert.ok(!(await (await fetch(`${base}/setup/${n1.setup_token}`)).text()).includes(`/inbox/${n1.inbox_token}`));

// ---- Nov 2026 rework: no drafts, waiting list, machine requests, reminders, Claude connector ----
const { listRequests, ensureMcpToken } = await import('../src/db.js');
const { sendReminder, ensureTopic } = await import('../src/engine.js');
const mch = getChannelBy('id', 'mounir');
assert.equal(mch.drafts_enabled, 0, 'drafts are off by default');
assert.equal(by('31612340001').draft, '', 'no draft written when drafts are off');
const reqs = listRequests('mounir');
assert.ok(reqs.some((r) => /volvo/i.test(r.machine) && r.contact === '31612340001'), 'machine request saved');
assert.ok(reqs.some((r) => /john deere/i.test(r.machine)));
// a "thanks" with nothing to answer closes itself
await hook(inbound('31612340005', 'Transport BV', text('Thanks')));
await processPending();
assert.equal(db.prepare("SELECT status, done_reason FROM items WHERE contact = '31612340005'").get().done_reason, 'no_reply_needed');
const ihtml = await (await fetch(`${base}/inbox/${tok}`)).text();
assert.ok(ihtml.includes('Open chat in WhatsApp') && ihtml.includes('waiting'), 'inbox shows waiting cards without drafts');
const mhtml = await (await fetch(`${base}/inbox/${tok}/machines?days=30&q=volvo`)).text();
assert.ok(mhtml.includes('Volvo') && !mhtml.includes('John Deere'), 'machines page filters');
const csv = await (await fetch(`${base}/inbox/${tok}/machines.csv?days=30`)).text();
assert.ok(csv.includes('"Machine"') && /Volvo/.test(csv));
const thtml = await (await fetch(`${base}/inbox/${tok}/tools`)).text();
assert.ok(thtml.includes('ntfy') && thtml.includes('/mcp/'), 'tools page shows ntfy topic and connector link');
const rem = await sendReminder(getChannelBy('id', 'mounir'), { force: true });
assert.ok(rem.dryRun && /Jan de Vries/.test(rem.body), 'reminder lists waiting customers');
await fetch(`${base}/inbox/${tok}/tools/save`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'remind_times=08:30, 16:00, bad&remind_after_hours=2' });
assert.equal(getChannelBy('id', 'mounir').remind_times, '08:30,16:00');
// Claude connector (MCP)
const mtok = getChannelBy('id', 'mounir').mcp_token;
const rpc = async (body) => { const r = await fetch(`${base}/mcp/${mtok}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }); return [r.status, r.status === 200 ? await r.json() : null]; };
let [st, j] = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
assert.equal(j.result.protocolVersion, '2025-06-18');
[st] = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }); assert.equal(st, 202);
[, j] = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
assert.ok(j.result.tools.some((t) => t.name === 'whatsapp_overview') && !j.result.tools[0].run);
[, j] = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whatsapp_overview', arguments: {} } });
assert.ok(/WAITING/.test(j.result.content[0].text) && /Jan de Vries/.test(j.result.content[0].text));
[, j] = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_whatsapp', arguments: { query: 'zaterdag' } } });
assert.ok(/Jan de Vries/.test(j.result.content[0].text) && !/Tom Baker/.test(j.result.content[0].text));
[, j] = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_machine_requests', arguments: { search: 'deere' } } });
assert.ok(/John Deere/.test(j.result.content[0].text));
[, j] = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_conversation', arguments: { customer: '+31 6 1234 0001' } } });
assert.ok(/zaterdag/.test(j.result.content[0].text));
[, j] = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'mark_handled', arguments: { customer: 'Tom Baker' } } });
assert.ok(/marked as handled/.test(j.result.content[0].text));
assert.ok(!db.prepare("SELECT 1 FROM messages WHERE contact = '31655555555'").get(), 'private still never stored');
assert.equal((await fetch(`${base}/mcp/wrong`, { method: 'POST', body: '{}' })).status, 404);
// Broadcast: vCard import, keyword lists, opt-out, send through the template
const vcf = ['BEGIN:VCARD','VERSION:3.0','FN:Alberto Spain Yanmar Vio50','TEL;type=CELL:+34 612 34 56 78','END:VCARD',
  'BEGIN:VCARD','VERSION:3.0','N:Komatsu Pw180;Alejandro Spain;;;','TEL;type=CELL:0034 699 11 22 33','END:VCARD',
  'BEGIN:VCARD','VERSION:3.0','FN:Abdelali Mourad Maroc','TEL:+212 6 61 22 33 44','PHOTO;ENCODING=b:AAAA','END:VCARD',
  'BEGIN:VCARD','VERSION:3.0','FN:Jan Buurman','TEL;type=CELL:06 1111 2222','END:VCARD',
  'BEGIN:VCARD','VERSION:3.0','FN:Cus Spain Optout','TEL:+34 600 000 001','END:VCARD'].join('\r\n');
const imp = await fetch(`${base}/inbox/${tok}/broadcast/import`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: vcf });
assert.ok((await imp.text()).includes('5 contacts'));
assert.ok(db.prepare("SELECT 1 FROM contacts WHERE phone = '31611112222'").get(), 'Dutch local number gets 31');
const bhtml = await (await fetch(`${base}/inbox/${tok}/broadcast`)).text();
assert.ok(bhtml.includes('Spain') && bhtml.includes('Maroc') && bhtml.includes('Contacts: 5') === false);
await hook(inbound('34600000001', 'Cus', text('STOP')));
const { getList, recipients } = await import('../src/broadcast.js');
const spain = db.prepare("SELECT * FROM blists WHERE channel_id = 'mounir' AND name = 'Spain'").get();
assert.deepEqual(recipients('mounir', spain).map((r) => r.phone).sort(), ['34612345678', '34699112233'], 'Spain list by keyword/prefix, STOP excluded');
// untick Alejandro
await fetch(`${base}/inbox/${tok}/broadcast/list/${spain.id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `name=Spain&keywords=${encodeURIComponent(spain.keywords)}&all=34612345678,34699112233,34600000001&keep=34612345678` });
assert.deepEqual(recipients('mounir', getList('mounir', spain.id)).map((r) => r.phone), ['34612345678']);
const sres = await fetch(`${base}/inbox/${tok}/broadcast/send`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `list=${spain.id}&text=${encodeURIComponent('New: Volvo EC220E\n2018, 6400 h')}` });
assert.equal(sres.status, 303);
await new Promise((r) => setTimeout(r, 100));
const bs = db.prepare('SELECT * FROM bsends ORDER BY id DESC').get();
assert.equal(bs.sent, 1); assert.equal(bs.status, 'done'); assert.ok(bs.text.includes(' · '), 'line breaks flattened');
console.log('\nNEW FEATURES OK');

if (process.argv.includes('--keep')) { console.log(`\nServer kept running: ${base}/inbox/${tok}`); }
else { server.close(); console.log('\nALL TESTS PASSED'); process.exit(0); }
