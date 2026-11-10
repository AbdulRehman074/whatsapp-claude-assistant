// Admin commands (run on the server):
//   npm run cli -- add mounir "Mounir - Nedtrax" Mounir [summaryTo] [HH:MM]
//   npm run cli -- links mounir
//   npm run cli -- set mounir summary_to 31612345678
//   npm run cli -- set mounir summary_time 18:00
//   npm run cli -- private mounir 31611111111,31622222222
//   npm run cli -- template mounir         (submit the daily summary template for approval)
//   npm run cli -- summary mounir          (send today's summary now, for testing)
//   npm run cli -- list
import { config } from './config.js';
import { addChannel, getChannelBy, updateChannel, listChannels, addPrivate, digits } from './db.js';
import { sendSummary } from './engine.js';
import { createSummaryTemplate } from './provider360.js';

const [cmd, ...a] = process.argv.slice(2);
const links = (ch) => console.log(`
${ch.label} (${ch.id})
  Setup link (send to the number owner once): ${config.publicUrl}/setup/${ch.setup_token}
  Inbox link (owner only, keep private):      ${config.publicUrl}/inbox/${ch.inbox_token}
  Webhook (set automatically on setup):       ${config.publicUrl}/webhook/${ch.id}/${ch.webhook_secret}
  Connected: ${ch.d360_api_key ? 'yes' : 'no'} · Number: ${ch.display_number || '-'} · Summary to: ${ch.summary_to || '-'} at ${ch.summary_time}`);

const SETTABLE = ['label', 'owner_name', 'summary_to', 'summary_time', 'summary_template', 'summary_template_lang', 'knowledge_file'];

switch (cmd) {
  case 'add': {
    const [id, label, ownerName, summaryTo, summaryTime] = a;
    if (!id || !label || !ownerName) { console.log('usage: add <id> "<label>" <ownerName> [summaryTo] [HH:MM]'); process.exit(1); }
    links(addChannel({ id, label, ownerName, summaryTo, summaryTime })); break;
  }
  case 'links': { const ch = getChannelBy('id', a[0]); if (!ch) throw new Error('no such channel'); links(ch); break; }
  case 'list': listChannels().forEach(links); break;
  case 'set': {
    const [id, field, value] = a;
    if (!SETTABLE.includes(field)) { console.log('settable:', SETTABLE.join(', ')); process.exit(1); }
    updateChannel(id, { [field]: field === 'summary_to' ? digits(value) : value }); links(getChannelBy('id', id)); break;
  }
  case 'private': { const ch = getChannelBy('id', a[0]); String(a[1] || '').split(',').map(digits).filter(Boolean).forEach((p) => addPrivate(ch.id, p)); console.log('added'); break; }
  case 'summary': { const ch = getChannelBy('id', a[0]); console.log(await sendSummary(ch, { force: true })); break; }
  case 'template': { const ch = getChannelBy('id', a[0]); if (!ch?.d360_api_key) throw new Error('number not connected yet');
    console.log(await createSummaryTemplate(ch.d360_api_key, ch.summary_template, ch.summary_template_lang)); break; }
  default: console.log('commands: add, links, list, set, private, template, summary');
}
