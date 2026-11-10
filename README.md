# WhatsApp Business assistant with Claude

Sorts incoming WhatsApp Business messages, flags the urgent ones, and writes reply drafts in the customer's language. The owner reviews each draft on a private phone inbox page and sends it from the WhatsApp Business app with one tap. A daily summary arrives on WhatsApp.

- Works with the WhatsApp Business app through 360dialog coexistence, so the phone app keeps working as normal.
- One install serves several numbers. Each number has its own private inbox.
- Private contacts are dropped before anything is stored or sent to Claude.
- Runs on the owner's own accounts: Render (hosting), Anthropic (Claude API) and 360dialog (WhatsApp).

## Install

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AbdulRehman074/whatsapp-claude-assistant)

1. Click the button, sign in to Render, paste your Anthropic API key, and deploy.
2. Open the service address, then fill in the one-time setup form. Bookmark the admin page it opens.
3. Open the number's setup link and paste your 360dialog API key.

## Develop

Node 22.13+ with no dependencies. Run `npm test` (offline: `MOCK_CLAUDE` plus a dry-run sender) and `npm start`.
