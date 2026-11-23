# NEO browser authentication and hosting decision

**Status:** architecture decision record; implementation is intentionally gated on the owner choosing the real hostname and authentication mode.  
**Scope:** NEO browser client and Cloudflare Worker only. This is not a production deployment approval.

## 1. What the repository actually contains

- The NEO API is a Cloudflare Worker. It accepts either the Cloudflare Access-injected `Cf-Access-Jwt-Assertion` or a native/controlled-client `Authorization: Bearer` token. Both use the same RS256 signature validation against the configured Cloudflare Access JWKS, exact issuer, configured audience, expiry and verified `sub` account key.
- First device enrolment and every subsequent signed device operation use the same token-source precedence: if the assertion header is present it is authoritative and invalid/empty values fail closed; otherwise the Worker accepts a bearer token. Subsequent device operations additionally require a P-256 signed device proof with a five-minute timestamp window and one-use nonce.
- The browser transport is a library, not a NEO application. `NeoDeviceClient.create(baseUrl, accessToken, accountScope)` accepts an optional host-supplied token callback. When supplied, enrolment and each signed request obtain a fresh token. When omitted, the client sends same-origin credentials so Cloudflare Access can use its HttpOnly session cookie and inject the assertion. The client does not intentionally store access tokens in IndexedDB and does not implement identity-provider login, refresh or logout.
- IndexedDB stores a per-account device ID, a non-exportable P-256 private `CryptoKey`, the public JWK, encrypted memory cache records, ciphertext outbox entries and sync metadata. The account scope is hashed before it is used as a local namespace. The browser client transports encrypted records; it does not implement the memory-encryption key or its backup.
- The current OpenJarvis React app is built by Vite into `src/openjarvis/server/static`; FastAPI serves that SPA and its assets from the same origin. Vite development proxies API paths to the local FastAPI server. The Vite PWA configuration precaches build assets and excludes API paths from navigation fallback; no runtime API caching rule is configured. FastAPI currently adds a broad CSP (`default-src 'self' 'unsafe-inline' 'unsafe-eval'; media-src 'self' blob:`) to the existing OpenJarvis app; that policy is not suitable for NEO. The Tauri desktop app is a separate local-webview deployment with its own CSP.
- The repository does not contain a NEO browser UI, a NEO browser hostname, a Worker custom-domain/route binding, a Cloudflare Pages project, a NEO response-header configuration, a Worker CORS allowlist/preflight handler, or a configured browser identity-provider SDK. The Worker Wrangler config has `workers_dev = true` and placeholder Access issuer, audience and D1 ID values; those are not deployment decisions.

These are separate products and trust boundaries. The existing OpenJarvis API-key flow and Tauri CSP must not be treated as NEO browser authentication or hosting configuration.

## 2. Hosting boundary

**Do not wire NEO into the existing OpenJarvis frontend or expose the Worker on a guessed hostname.** First choose the NEO browser hostname, the hosting operator, and whether the NEO API is reached through the same origin.

Recommended default for the first browser release:

1. Serve the NEO browser app and its API through one HTTPS origin.
2. Route a dedicated path prefix (for example, a future `/neo-api/` path) to the Worker through an explicitly configured Cloudflare route/reverse proxy.
3. Keep the browser app, auth callback and API on that same origin where practical. This avoids adding a permissive cross-origin policy to the Worker.
4. The Worker currently has no CORS allowlist or OPTIONS/preflight handler. If separate origins are deliberately chosen, implement and test an exact-origin allowlist, explicit preflight handling and a documented credentials policy before using the browser client cross-origin. Never use `Access-Control-Allow-Origin: *` with credentials. The current cookie path is same-origin only.
5. Do not cache authenticated API responses, Access tokens, memory payloads or task payloads in a service worker/CDN cache.

The example path above is a topology proposal, not a configured route. The actual hostname, path, hosting provider and TLS/DNS ownership remain owner decisions.

## 3. Authentication decision and token lifecycle

### Current server contract

The Worker accepts either `Cf-Access-Jwt-Assertion` (the Cloudflare Access browser assertion) or `Authorization: Bearer <Cloudflare Access JWT>` (native/controlled clients). The assertion header takes precedence whenever it is present; an invalid assertion never falls back to a valid bearer header. Both paths are verified by the same RS256 JWKS, exact issuer, configured audience, expiry and optional not-before (`nbf`) checks. An email or unsigned identity header alone is never trusted. The account ID comes from the verified `sub` claim. First-device enrolment and later signed routes now share this token extraction contract. Device authorization is a second independent factor: an enrolled device must sign each protected request with its P-256 private key.

Cloudflare documents the Access application-token `sub` as a user ID unique to an email address within a Zero Trust account (not the email claim itself). It can change if the identity is removed and re-added or authenticates through a different Zero Trust account. The Worker persists `sub` directly as `account_id`; therefore the chosen Access team/identity-provider tenant is part of NEO's account namespace. Keep that tenant stable for the initial release and plan an explicit account-data migration before changing it. The browser client's `accountScope` must be derived from that same verified subject, never from the email address or display name.

A generic OIDC access token is **not** interchangeable with this token. Unless the Worker trust contract is deliberately changed and reviewed, the token must be issued for the configured Cloudflare Access issuer and application audience. The Worker now rejects a future `nbf` and non-finite/missing expiry or subject values; a missing `nbf` remains allowed because JWTs may omit that optional claim.

### Browser-specific Access caveat

Cloudflare Access browser sessions use an HttpOnly `CF_Authorization` cookie. Cloudflare sends a signed `Cf-Access-Jwt-Assertion` header to the protected origin. Browser JavaScript cannot read an HttpOnly cookie, and the app must not scrape cookies or copy a token out of browser storage.

Official references:
- [Cloudflare Access authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

**Recommended browser direction:** protect the chosen app/API hostname with Cloudflare Access and have the Worker validate the Access-injected `Cf-Access-Jwt-Assertion` header. The development branch accepts this assertion and retains bearer-token support for native/controlled clients. First enrolment and subsequent signed requests use the same RS256 signature, exact issuer, configured audience and expiry checks. If the assertion header is present but invalid, the Worker fails closed rather than falling back to a bearer token. Focused integration coverage exercises assertion authentication, invalid-assertion precedence and first-device enrolment without a JavaScript bearer token; the new regression is pending CI on the current branch head. Never trust unsigned email headers.

If the owner instead chooses a browser identity SDK that supplies a short-lived Access JWT to JavaScript, use the following contract:

- Keep any short-lived access token only in the host/provider's memory; do not put it in localStorage, sessionStorage, IndexedDB, URLs, logs or analytics.
- The host's `accessToken()` callback must obtain/refresh through the selected identity provider and return a currently valid Access JWT. The NEO transport calls it for first enrolment and every signed request; the returned value is used only to construct that request's Authorization header and is not persisted by the client.
- The identity provider owns refresh-token rotation and interactive reauthentication; do not build a parallel refresh-token store or custom refresh protocol.
- On sign-out, invoke the selected provider's logout/revocation flow, clear its in-memory token/session state, discard the old client/callback references and clear in-memory account data. In cookie mode, the provider/Access logout flow must invalidate the HttpOnly session; JavaScript cannot clear or read that cookie directly. The persisted device key is a separate device identity; delete it only when the user explicitly removes/forgets that browser device.
- A 401/403 is an authentication boundary, not a network retry. The outbox must remain intact; require reauthentication before a user-initiated retry. Existing `flushOutbox()` stops on 401/403 and leaves the blocked item stored.
- Use a stable opaque account subject from the identity provider for `accountScope`; do not use an email address, display name or bearer token as the scope.

No browser sign-in, refresh, sign-out or recovery provider is configured today. The Access-cookie assertion path versus a JavaScript token callback is an explicit owner/architecture decision, not something to infer from placeholder values.

## 4. Device and account recovery

- The Worker exposes per-device revocation through `DELETE /v1/devices/{device_id}`, authorized by another active device/account session. It does not currently expose a bulk account-wide device revocation or self-service account recovery endpoint.
- If a browser profile is lost, IndexedDB is cleared, or the browser evicts the non-exportable key, the client cannot sign with the old identity; a new key/device ID must be enrolled and the old server-side device record revoked from another authorized session.
- Important current limitation: `NeoDeviceClient.create()` reuses an existing IndexedDB identity, including a key whose server-side device has since been revoked. There is no supported browser reset/rotate/forget-device API. Clearing the entire IndexedDB database forces a new key but also destroys the encrypted cache, cursor and queued outbox. A safe key-rotation path that preserves queued ciphertext is not implemented or tested; this is a release blocker before real browser users.
- If an account is recovered after compromise, the identity provider must terminate compromised sessions first. Then review the device list and revoke every unknown/lost device. The exact identity-provider recovery and administrator escalation procedure must be chosen before real users are onboarded.
- A disconnected device cannot receive remote revocation or remote wipe until it reconnects. Server-side revocation blocks its next request; it does not erase local ciphertext or revoke a local memory-encryption key.
- The browser client does not implement memory encryption/key recovery itself. It transports encrypted payloads. Losing the separate memory-encryption key may make cached/server ciphertext unrecoverable; define and test that key-backup/recovery policy before storing valuable personal memory.

## 5. CSP and XSS controls

CSP must be delivered as an HTTP response header by the real hosting layer. A meta tag is not an adequate substitute for the full policy.

1. Start with `Content-Security-Policy-Report-Only` on the selected real host. Collect violations while exercising login/logout, API calls, PWA updates, voice, telemetry, fonts, images and any WebSocket/streaming path.
2. Inventory exact script, style, connect, image, font, media, worker, frame and reporting origins. Do not infer them from the current Tauri config or use scheme-wide `http:`, `https:`, `ws:` or `wss:` sources.
3. Begin with a restrictive baseline: `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`; keep `script-src` free of `'unsafe-inline'` and `'unsafe-eval'`. Use per-response nonces/hashes only if an inventoried inline script is proven necessary.
4. Set `connect-src` to the app's own origin plus the exact approved API/auth/telemetry/WebSocket origins. Keep image/font/media/worker sources equally narrow.
5. Add a reporting endpoint only after it exists and is access-controlled; review reports, remove violations and then enforce the policy in disposable staging before production.
6. Add Trusted Types where supported after testing the React, Markdown and plugin surface. Keep React's normal escaping; avoid raw HTML sinks. If rich HTML is required, sanitize with a maintained allowlist sanitizer and test URL schemes.
7. Do not cache authenticated API data or tokens in the PWA service worker. Review dependency changes and service-worker update behavior.

The existing OpenJarvis FastAPI CSP is also not a template: it currently permits `'unsafe-inline'` and `'unsafe-eval'` through a broad `default-src`, and the Tauri CSP separately permits inline scripts plus broad `http:`, `https:`, `ws:`, `wss:` connections. Neither policy is evidence for NEO's actual origins. Tightening either existing product's policy is a separate compatibility task; do not mix it into the NEO browser-host policy without testing its current API, voice, PWA, Tauri IPC/updater and local-service paths.

In the inspected existing chat-message renderer, ReactMarkdown is used without enabling `rehypeRaw`; the citation plugin creates links with `rel="noopener noreferrer"`. This is a useful narrow control, not a whole-frontend XSS audit and not evidence for a future NEO UI. No NEO browser UI exists yet. Avoid raw HTML sinks in the NEO app; if rich HTML is unavoidable, sanitize it with a maintained allowlist sanitizer and test URL schemes.

**Threat boundary:** a non-exportable IndexedDB `CryptoKey` prevents straightforward private-key export, but same-origin XSS can still invoke signing operations and can call a JavaScript token callback. CSP reduces injection opportunities; it does not make a compromised origin safe. Keep the origin's script supply chain small and treat every third-party script as privileged code.

## 6. Tests and what they prove

- Earlier baseline commit `dc45f8a...` passed 51/51 Vitest tests and native Playwright IndexedDB persistence 9/9 across Chromium, Firefox and WebKit. That result predates the Access-assertion implementation and must not be treated as current-head verification.
- The Playwright suite validates browser CryptoKey persistence, encrypted cache recovery and ciphertext outbox replay. It does not validate a real Access login, production CSP headers, CORS, account recovery or real host origins.
- Browser client tests cover fresh callback tokens on enrolment and requests, no IndexedDB token persistence, and same-origin cookie-mode requests. The new cookie-enrolment and invalid-assertion enrolment regressions are pending CI on the current branch head.
- Worker integration covers the Access-injected assertion on signed routes and enrolment, invalid-assertion precedence, and rejection of a future `nbf`. The test environment uses a mocked Access JWKS and local SQLite-backed D1; it does not prove Cloudflare Access edge injection or remote D1 behavior.
- No live-host CSP/authentication test or independent penetration test has been performed.

## 7. Owner decisions and morning gates

1. Choose the NEO browser hostname and hosting provider; confirm who controls DNS/TLS and response headers.
2. Approve the recommended Cloudflare Access cookie/assertion browser flow, or explicitly choose a supported token-provider flow that can issue the exact JWT the Worker validates.
3. Choose same-origin Worker routing or approve the exact separate-origin CORS policy.
4. Only then authorize disposable Cloudflare staging, create the Access application and isolated D1, fill the real issuer/audience/database values, apply migrations 0001–0008, and run remote smoke tests.
5. Rehearse Worker rollback and D1 backup/restore only in disposable staging.
6. Separately complete Android emulator results and physical Pixel/Samsung device recovery tests with the owner present.

No Cloudflare resources, DNS, secrets, provider credentials or production services were changed for this decision record. Phase 1 remains open.
