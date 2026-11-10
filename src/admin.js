// First-run wizard and admin page: everything the owner needs, in the browser, no terminal.
import { esc, CSS } from './inbox.js';
import { config } from './config.js';
import { db, listChannels, getSetting } from './db.js';

const page = (title, sub, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}
label{display:block;font-weight:600;margin:12px 0 4px}input[type=text],input[type=tel],input[type=time]{width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);font:inherit;background:var(--bg);color:var(--ink)}
main a{color:var(--accent)}
.hint{color:var(--muted);font-size:14px;margin:2px 0 0}.ok{color:var(--accent);font-weight:700}.bad{color:var(--urgent);font-weight:700}
.linkbox{display:flex;gap:8px;align-items:center}.linkbox input{flex:1;font-size:13px}
textarea.k{min-height:260px;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace}
.welcome{background:var(--warn-bg);color:var(--warn);border-radius:12px;padding:12px 14px;margin:12px 0}
pre.out{white-space:pre-wrap;background:var(--chip);border-radius:10px;padding:10px;font-size:14px}
</style></head><body><header><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</header><main>${body}</main>
<script>document.addEventListener('click',async e=>{const b=e.target.closest('[data-copy]');if(!b)return;const i=document.getElementById(b.dataset.copy);
try{await navigator.clipboard.writeText(i.value)}catch{i.select();document.execCommand('copy')}b.textContent='Copied'});</script></body></html>`;

export function renderWizard() {
  return page('Set up your WhatsApp assistant', 'One-time setup. Takes 1 minute.', `
<form method="post" class="card">
<label for="owner">Your first name</label><input type="text" id="owner" name="owner" required placeholder="e.g. Mounir">
<p class="hint">Used to sign reply drafts when a sign-off fits.</p>
<label for="label">Name for this WhatsApp number</label><input type="text" id="label" name="label" value="Number 1" required>
<label for="sumto">WhatsApp number for your daily summary (optional)</label><input type="tel" id="sumto" name="summary_to" placeholder="+31 6 ...">
<p class="hint">Must be a different WhatsApp number than the one you connect. You can add it later.</p>
<label for="sumtime">Summary time</label><input type="time" id="sumtime" name="summary_time" value="18:00">
<div class="btns"><button class="btn primary">Create my assistant</button></div></form>`);
}

export function renderAdmin(adminToken, { welcome = false, notice = '', testResult = null } = {}) {
  const chans = listChannels();
  const base = `/admin/${adminToken}`;
  const claudeOk = !!config.anthropicKey || config.mockClaude;
  const cards = chans.map((ch) => {
    const setup = `${config.publicUrl}/setup/${ch.setup_token}`;
    const stats = db.prepare("SELECT SUM(status='open') o, SUM(status='open' AND urgent=1) u, COUNT(*) n FROM items WHERE channel_id = ?").get(ch.id);
    return `<section class="card" id="${esc(ch.id)}">
<div class="top"><div><div class="who">${esc(ch.label)}</div><div class="num">${ch.display_number ? '+' + esc(ch.display_number) : 'number not connected yet'}</div></div>
<div>${ch.d360_api_key ? '<span class="ok">Connected</span>' : '<span class="bad">Not connected</span>'}</div></div>
${ch.d360_api_key ? `<p class="hint">${stats.o || 0} open chats (${stats.u || 0} urgent) · ${stats.n || 0} in the last 30 days</p>` : ''}
<label>Setup link for this number</label>
<div class="linkbox"><input type="text" id="s-${esc(ch.id)}" value="${esc(setup)}" readonly><button data-copy="s-${esc(ch.id)}">Copy</button></div>
<p class="hint">The person who uses this number opens this link to connect it, and gets their private inbox link there. ${ch.d360_api_key ? '' : '<a href="' + esc(setup) + '">Open it yourself</a> if this is your number.'}</p>
<details><summary>Business knowledge for reply drafts</summary>
<form method="post" action="${base}/ch/${esc(ch.id)}/knowledge"><textarea class="k" name="knowledge">${esc(ch.knowledge_text || '')}</textarea>
<p class="hint">Claude only uses facts from this text. Paste your stock and price list and your standard answers here. Leave a line as TO FILL if unknown.</p>
<div class="btns"><button class="btn primary">Save knowledge</button></div></form></details>
<details><summary>Daily summary</summary>
<form method="post" action="${base}/ch/${esc(ch.id)}/summary">
<label>Send the summary to WhatsApp number</label><input type="tel" name="summary_to" value="${ch.summary_to ? '+' + esc(ch.summary_to) : ''}" placeholder="+31 6 ...">
<label>Time (Amsterdam)</label><input type="time" name="summary_time" value="${esc(ch.summary_time || '18:00')}">
<div class="btns"><button class="btn primary">Save</button></div></form>
${ch.d360_api_key ? `<div class="btns"><form method="post" action="${base}/ch/${esc(ch.id)}/template"><button>1. Submit summary template to WhatsApp</button></form>
<form method="post" action="${base}/ch/${esc(ch.id)}/send-summary"><button>2. Send a summary now (test)</button></form></div>
<p class="hint">Do step 1 once. WhatsApp approves it within minutes to 24 hours. After that, summaries arrive every day by themselves.</p>` : '<p class="hint">Connect the number first.</p>'}
</details>
<details><summary>More</summary><div class="btns">
<form method="post" action="${base}/ch/${esc(ch.id)}/test"><button>Test a reply draft</button></form>
<form method="post" action="${base}/ch/${esc(ch.id)}/new-inbox" onsubmit="return confirm('Create a new inbox link? The old one stops working. The owner opens the setup link again to get the new one.')"><button>New inbox link</button></form>
</div></details></section>`;
  }).join('');
  return page('Assistant admin', 'Bookmark this page. It is your private admin link; do not share it.', `
${welcome ? `<div class="welcome"><b>Your assistant is created.</b> Bookmark this page now (it is your admin link). Next: connect your number with the setup link below.</div>` : ''}
${notice ? `<div class="need">${esc(notice)}</div>` : ''}
${testResult ? `<div class="card"><div class="who">Test draft</div><p class="hint">Sample customer message: "${esc(testResult.sample)}"</p><pre class="out">${esc(JSON.stringify(testResult.result, null, 2))}</pre></div>` : ''}
<div class="card"><div class="who">Status</div>
<p>Claude API key: ${claudeOk ? '<span class="ok">set</span>' : '<span class="bad">missing</span> (add ANTHROPIC_API_KEY in your hosting settings > Environment)'}</p></div>
${cards}
<details class="card"><summary>Add another WhatsApp number</summary>
<form method="post" action="${base}/add"><label>Name for the number</label><input type="text" name="label" required placeholder="e.g. Number 2 or Colleague">
<label>First name of the person who uses it</label><input type="text" name="owner" required>
<div class="btns"><button class="btn primary">Add number</button></div></form>
<p class="hint">Each number gets its own setup link and its own private inbox. Nobody sees another number's messages.</p></details>`);
}

export const adminToken = () => getSetting('admin_token');
