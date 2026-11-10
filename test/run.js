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

if (process.argv.includes('--keep')) { console.log(`\nServer kept running: ${base}/inbox/${tok}`); }
else { server.close(); console.log('\nALL TESTS PASSED'); process.exit(0); }
