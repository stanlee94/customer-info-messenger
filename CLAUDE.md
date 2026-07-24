# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that injects a customer-info panel into Meta Business Suite's Messenger inbox (`https://business.facebook.com/latest/inbox/*`). By default the panel sits above the "Contact details" section in the right sidebar; users can drag it anywhere on screen via the handle at the top.

Plain JS/HTML/CSS, no build step, package manager, or test suite — loaded directly as an unpacked extension.

## Development workflow

- Reload via `chrome://extensions` after editing (full reload needed if `manifest.json` changes).
- Config lives in `chrome.storage.local`, set via the options page (`chrome://extensions` → this extension → "Details" → "Extension options"):
  - `manychatToken` — ManyChat API token.
  - `baserowBaseUrl` / `baserowToken` / `baserowUsersTableId` (`749`) / `baserowOrdersTableId` (`750`). If the base URL's host changes, also update `host_permissions` in `manifest.json`.
  - `aiApiUrl` / `aiApiToken` — AI Reply backend base URL (trailing slash stripped on save) and optional Bearer token. The backend must expose `GET /ai/health` and `POST /ai/reply`. Also add the backend host to `host_permissions` in `manifest.json` once the URL is known.
- Debugging: `content.js` logs to the Business Suite tab's DevTools console; `background.js` via the "service worker" link on `chrome://extensions`.
- No live Facebook/ManyChat/Baserow sandbox for CLI testing — verify DOM-scraping and API changes manually in a real Business Suite tab.

## Module docs

@import ./docs/core-architecture.md
@import ./docs/ui-panel.md
@import ./docs/ai-rewrite.md
@import ./docs/manychat.md
@import ./docs/baserow.md
@import ./docs/cart-summary-buttons.md
@import ./docs/cart-modal.md
@import ./docs/order-modal.md
@import ./docs/parcel-photos.md
