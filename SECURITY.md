# Security

Hatswap holds login sessions, so bugs in it matter more than usual. If you find a way to read saved sessions without the master password, make the extension send data anywhere, or escape the per-site permission model, please report it privately rather than in a public issue.

**How:** use GitHub's private vulnerability reporting on this repository (Security tab → "Report a vulnerability"). You'll get a reply within a few days, and credit in the release notes if you want it.

**What's in scope:** everything in `extension/`. The test site and the homepage are not.

**What Hatswap promises, so you know what counts as a bug:**
- No network requests, ever.
- Saved sessions are only readable with the master password (AES-256-GCM, key from PBKDF2-SHA256 at 600,000 iterations).
- The derived key lives only in `chrome.storage.session` while unlocked.
- Host access is per site, requested only when you save an account there, and removed when the last account for that site is deleted.
