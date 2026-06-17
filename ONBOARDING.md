# Onboarding — Customer Info Messenger (Chrome Extension)

This guide walks a new machine from zero to a fully working extension.

---

## What this extension does

Injects a customer purchase info panel into Meta Business Suite Messenger
(`business.facebook.com/latest/inbox/*`) for a specific Facebook page.
When a conversation is opened, it automatically looks up the customer in
ManyChat (for PSID) and Baserow (for order history, RFM score, address) and
shows a summary panel in the right sidebar above "Contact details".

---

## Prerequisites

- Google Chrome (or any Chromium browser)
- Access to the team's ManyChat account (to get an API token)
- Access to the team's Baserow instance (to get an API token)
- The extension source code folder on your machine

---

## Step 1 — Get the source code

Clone or copy the extension folder onto your machine. The folder should contain:

```
customer-info-messenger/
  manifest.json
  content.js
  background.js
  options.html
  options.js
  styles.css
```

No `npm install` or build step needed — it loads directly as-is.

---

## Step 2 — Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `customer-info-messenger` folder
5. The extension appears in your list with the name **"Customer Purchase Info for Messenger"**

---

## Step 3 — Configure the extension options

This is the most important step. Without these tokens the extension will load
but all lookups will fail.

### Open the options page

In `chrome://extensions`, find the extension → click **Details** → scroll down
and click **Extension options**.

### Fill in every field

| Field | Value | Where to get it |
|---|---|---|
| **ManyChat API Token** | Your ManyChat Bearer token | ManyChat dashboard → Settings → API → copy the token |
| **Baserow Base URL** | `https://baserow.dd-herbs.com` | Pre-filled — leave as-is unless the host changes |
| **Baserow API Token** | Your Baserow personal API token | Baserow → top-right avatar → Settings → API tokens → create or copy one |
| **Users Table ID** | `749` | Pre-filled — the "Users" table in Baserow |
| **Orders Table ID** | `750` | Pre-filled — the "Orders" table in Baserow |

Click **Save**. You should see "Saved." appear briefly.

> **Note:** tokens are stored in `chrome.storage.local` — they stay on this
> machine only and are never synced to other devices.

---

## Step 4 — Open Meta Business Suite on the correct page

The extension only activates on your specific Facebook page. It checks for
`asset_id=103550019254847` in the URL.

1. Go to [business.facebook.com](https://business.facebook.com)
2. Navigate to your page's **Inbox** — the URL should look like:
   ```
   https://business.facebook.com/latest/inbox/all?asset_id=103550019254847&...
   ```
3. Open any conversation — the panel appears in the right sidebar above
   "Contact details".

If the panel does not appear, see [Troubleshooting](#troubleshooting) below.

---

## Step 5 — Verify it's working

Open a conversation with a customer you know has orders. The panel should show:

- **UID** — scraped from the URL
- **Name** — scraped from the DOM ("View profile" anchor)
- **PSID** — looked up from `uidPsidMap` in local storage, or found via
  ManyChat name search
- **Total Spending / Total Purchase / Last Order / Rank / Address** — from
  Baserow Users table
- **Recent Orders** — last 5 orders from Baserow Orders table, sorted newest
  first
- **Cart buttons (ALL / MYR / SGD)** — if the cart session is valid (no action
  needed from you — the extension checks automatically)

### First-time customer (no PSID linked yet)

If the customer has never been linked, you'll see ManyChat candidate cards.
Click **Link** on the correct match. The PSID is saved to local storage and
Baserow is updated. Future visits load instantly.

---

## Step 6 — When to reload the extension

After any code change:

- **JS/CSS change** → go to `chrome://extensions` → click the **reload icon**
  (↺) on the extension card → refresh the Business Suite tab
- **`manifest.json` change** → same steps (full reload required)
- **Options change** → just save in the options page; no reload needed

---

## Troubleshooting

### Panel does not appear

1. Check the URL contains `asset_id=103550019254847`. If you're on a different
   Facebook page, the extension intentionally does nothing.
2. Open DevTools on the Business Suite tab (F12) and check the **Console** for
   errors from `content.js`.
3. Check the service worker logs: `chrome://extensions` → extension card →
   **"service worker"** link → inspect the console there for background errors.
4. Make sure the extension is enabled (the toggle on the extension card is blue).

### "ManyChat API token not set" error

The options page was not saved. Reopen options, paste the token, click Save.

### "Baserow is not configured" error

Same — reopen options, fill in the Baserow fields, click Save.

### Panel appears but shows wrong customer name

Business Suite's DOM updates asynchronously. The extension retries name
detection until it finds it. If it picks up the wrong name, click into a
different conversation and back — this resets detection.

### Cart buttons do not appear

The cart session check (`/checkSession` API) returned invalid. This means the
backend session cookie has expired. The cart API is self-managed — contact the
person who manages the Lambda/EC2 backend to refresh the session.

### "No ManyChat contact found" for a customer who exists

The name scraped from the DOM may not match ManyChat exactly. Use the search
bar below the candidates list:
- Type their **PSID** directly (numeric) to find by exact PSID
- Type their **Order ID** (starts with F) to find via order lookup

---

## Summary of what needs configuring

| Item | Where | Required |
|---|---|---|
| ManyChat API token | Extension options page | Yes |
| Baserow API token | Extension options page | Yes |
| Baserow Base URL | Extension options page | Pre-filled (`https://baserow.dd-herbs.com`) |
| Users Table ID | Extension options page | Pre-filled (`749`) |
| Orders Table ID | Extension options page | Pre-filled (`750`) |
| Cart API / session | Automatic (no config) | — |
| Facebook page filter | Hardcoded in `content.js` | No action needed |
