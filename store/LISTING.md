# Chrome Web Store listing: everything to paste

For Hatswap 1.6.0. Fields follow the order of the developer dashboard (chrome.google.com/webstore/devconsole). Images in this folder are regenerated with `node scripts/store-assets.mjs`.

## Before you start

1. Developer account: one-time $5 registration at the dashboard, with the Google account you want the listing tied to. Use a Google account you'll keep (it can't be transferred easily).
2. Upload package: build it with the command below. It's the `extension/` folder zipped, nothing else. Google wants the manifest at the zip's root, which this does.

```bash
cd extension && zip -r ../store/hatswap-1.6.0.zip . -x '.DS_Store' && cd ..
```

3. Start as **Unlisted** (Distribution → Visibility) so beta testers can install from the store link without the listing being searchable. Flip to **Public** on launch day. Both need the same review.
4. Review takes anywhere from a day to a couple of weeks for an extension with the `cookies` permission. Submit early.

## Store listing tab

**Name** (45 max): `Hatswap – Account Switcher`

**Summary** (132 max):
`Switch between accounts on the same site in one click. No logging out, no extra windows. Encrypted and stored only on your computer.`

**Description:**

```
Hatswap lets you switch between several accounts on the same website in one click, without logging out and back in. Made for people who manage several clients on Shopify, Buffer, Meta Business Suite, Google and similar tools.

HOW IT WORKS
1. Sign in to an account as usual and click "Save as New Account".
2. Click "New Account", sign in to the next one, and save it too.
3. From now on, switch with one click in the popup, or with Alt+Shift+H.

Each account gets a name, a colour and a client group, so "Fjord & Pine – Shopify" and "Nordlys – Shopify" are one click apart. The toolbar badge shows which account is active in every tab.

PRIVATE BY DESIGN
• Everything stays on your computer. Hatswap makes no network requests at all. No account, no server, no telemetry.
• Saved logins are encrypted with AES-256 using a master password you choose. Hatswap locks itself after a time you set.
• Access is granted one website at a time, when you save your first account there. Hatswap never asks for access to all websites.
• The source code is public: https://github.com/bogoza65/hatswap

BUILT FOR CLIENT WORK
• A guard that notices when you've signed in to a different account by hand, and asks before saving over a client's login.
• Keyboard shortcut to cycle through accounts on the current site.
• Search when you have many accounts.
• Encrypted backup export and restore, so your accounts survive a reinstall or move to another computer.

GOOD TO KNOW
Hatswap handles cookies and localStorage/sessionStorage. A few apps keep their login elsewhere (IndexedDB) or tie it to the device; those won't switch fully. It switches a whole site at once, so it's meant for business and client accounts, not for several personal profiles. Never click "Log out" inside a site for an account you've saved; use "New Account" instead. Details: https://github.com/bogoza65/hatswap#known-limitations

PERMISSIONS
cookies and scripting: to read and restore each account's session. storage: to keep the encrypted accounts. tabs/activeTab: to know which site you're on. Per-site access is requested only when you save an account there.
```

**Category:** Workflow & Planning. (Alternatives if the form has changed: Productivity → Workflow & Planning, or Privacy & Security.)

**Language:** English.

**Store icon:** `icon-128-store.png` (128×128, 96 px of art with 16 px transparent padding, as Google recommends).

**Screenshots** (1280×800, in this order; captions are already in the images):
1. `screenshot-1-switch.png`: Switch accounts without logging out.
2. `screenshot-2-save.png`: Name it. Colour it. Group it by client.
3. `screenshot-3-guard.png`: It asks before saving over the wrong account.
4. `screenshot-4-security.png`: Encrypted. Local only. Locks itself.
5. `screenshot-5-backup.png`: A backup you can keep anywhere.

**Small promo tile** (440×280): `promo-small-440x280.png`. **Marquee** (1400×560, optional): `promo-marquee-1400x560.png`.

**Promo video** (optional): upload `docs/hatswap-preview.mp4` to YouTube as unlisted or public, then paste the URL. Title it "Hatswap – switch accounts without logging out (Chrome extension)".

**Official URL / Homepage:** `https://bogoza65.github.io/hatswap/`
**Support URL:** `https://github.com/bogoza65/hatswap/issues`

## Privacy practices tab

**Single purpose description:**
`Lets the user save the login session of a website and switch between their saved accounts on that site in one click, without logging out. All data is stored encrypted on the user's device.`

**Permission justifications** (one box per permission):

- `cookies`: "Reads the current site's cookies when the user saves an account, and deletes/restores cookies when the user switches accounts. Cookies are stored encrypted on the device and never transmitted."
- `storage`: "Stores the user's saved accounts (encrypted with AES-GCM under a key derived from the user's master password) and the extension settings in chrome.storage.local. Nothing is synced or sent anywhere."
- `scripting`: "Reads and restores localStorage/sessionStorage in the site's open tabs when saving or switching an account, and unloads the page during a switch so the previous account's in-flight requests can't restore its session. Runs only on sites the user has granted access to."
- `tabs`: "Finds the open tabs of the site being switched so they can all be reloaded with the new account, and shows the active account's badge per tab."
- `activeTab`: "Identifies the website of the current tab so the popup can show that site's accounts."
- Host permissions (optional, `*://*/*` declared as optional only): "Requested per website, the first time the user saves an account on it (e.g. *://*.shopify.com/*). Needed for the cookies and scripting APIs on that site. Never requested for all sites; removed again when the user deletes the last account for a site."

**Remote code:** No, the extension does not use remote code.

**Data usage.** The honest answer: Hatswap handles the user's login cookies and site storage, but only on the device. Google's form asks what data the extension "collects", and local-only handling is a grey area in how they word it. Declaring it is the safe choice, and the certifications are true:
- Tick **Authentication information** (session cookies, tokens) and **Website content** (localStorage/sessionStorage of the sites the user saves). Everything else unticked.
- Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** `https://bogoza65.github.io/hatswap/privacy.html`

## Distribution tab

- Visibility: **Unlisted** for the beta, **Public** at launch.
- Regions: all.
- Pricing: free (the Pro licence, if it comes, is sold outside the store; the store listing stays free).

## After it's approved

1. Replace the three store links in `site/index.html` (search for `chromewebstore.google.com`) with the real listing URL `https://chromewebstore.google.com/detail/<id>`, republish the site (README has the command), and add the link to the README and the GitHub repo description.
2. Reply to every review within a day.
3. Each new version: bump `manifest.json`, re-zip with the command above, upload under Package, and write the "What's new" text.
