# NEO browser authentication and hosting decision

**Status:** architecture decision record; implementation is intentionally gated on the owner choosing the real hostname and authentication mode.  
**Scope:** NEO browser client and Cloudflare Worker only. This is not a production deployment approval.

## 1. What the repository actually contains

- The NEO API is a Cloudflare Worker. Its current verifier accepts a bearer JWT, validates RS256 signature against the configured Cloudflare Access JWKS, checks the exact issuer, configured audience and expiry, and uses the verified `sub` as the account key.
- First device enrolment requires an Access bearer token. Subsequent device operations require both the account token and a P-256 signed device proof with a five-minute timestamp window and one-use nonce.
- The browser transport is a library, not a NEO application. `NeoDeviceClient.create(baseUrl, accessToken, accountScope)` accepts a host-supplied token callback. Enrolment and every signed request call that callback again. The client does not intentionally store the returned token in IndexedDB.
- IndexedDB stores a per-account device ID, a non-exportable P-256 private `CryptoKey`, the public JWK, encrypted memory cache records, ciphertext outbox entries and sync metadata. The account scope is hashed before it is used as a local namespace.
- The current OpenJarvis React app is built by Vite into `src/openjarvis/server/static`; FastAPI serves that SPA and its assets from the same origin. Vite development proxies API paths to the local FastAPI server. The Tauri desktop app is a separate local-webview deployment with its own CSP.
- The repository does not contain a NEO browser UI, a NEO browser hostname, a Worker custom-domain/route binding, a Cloudflare Pages project, a production response-header configuration, a CORS allowlist, or a configured browser identity-provider SDK. The Wrangler Access issuer, audience and D1 ID are placeholders.

These are separate products and trust boundaries. The existing OpenJarvis API-key flow and Tauri CSP must not be treated as NEO browser authentication or hosting configuration.

## 2. Hosting boundary

**Do not wire NEO into the existing OpenJarvis frontend or expose the Worker on a guessed hostname.** First choose the NEO browser hostname, the hosting operator, and whether the NEO API is reached through the same origin.

Recommended default for the first browser release:

1. Serve the NEO browser app and its API through one HTTPS origin.
2. Route a dedicated path prefix (for example, a future `/neo-api/` path) to the Worker through an explicitly configured Cloudflare route/reverse proxy.
3. Keep the browser app, auth callback and API on that same origin where practical. This avoids adding a permissive cross-origin policy to the Worker.
4. If separate origins are deliberately chosen, add an exact-origin CORS allowlist, explicit preflight handling, and a documented credentials policy. Never use `Access-Control-Allow-Origin: *` with credentials.
5. Do not cache authenticated API responses, Access tokens, memory payloads or task payloads in a service worker/CDN cache.

The example path above is a topology proposal, not a configured route. The actual hostname, path, hosting provider and TLS/DNS ownership remain owner decisions.

## 3. Authentication decision and token lifecycle

### Current server contract

The Worker currently expects `Authorization: Bearer <Cloudflare Access JWT>`. It verifies the JWT itself; an email or identity header alone is not trusted. The account ID comes from the verified `sub` claim. Device authorization is a second independent factor: a registered device must sign each request with its P-256 private key.

A generic OIDC access token is **not** interchangeable with this token. Unless the Worker trust contract is deliberately changed and reviewed, the token must be issued for the configured Cloudflare Access issuer and application audience.

### Browser-specific Access caveat

Cloudflare Access browser sessions use an HttpOnly `CF_Authorization` cookie. Cloudflare sends a signed `Cf-Access-Jwt-Assertion` header to the protected origin. Browser JavaScript cannot read an HttpOnly cookie, and the app must not scrape cookies or copy a token out of browser storage.

Official references:
- [Cloudflare Access authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

**Recommended browser direction:** protect the chosen app/API hostname with Cloudflare Access and have the Worker validate the Access-injected `Cf-Access-Jwt-Assertion` header. The development branch now accepts this assertion and retains bearer-token support for native/controlled clients. Both inputs pass through the same RS256 signature, exact issuer, configured audience and expiry checks. If the assertion header is present but invalid, the Worker fails closed rather than falling back to a bearer token. A focused integration test covers assertion success and invalid-assertion precedence; its CI result is pending on the latest branch head. Never trust unsigned email headers.

If the owner instead chooses a browser identity SDK that supplies a short-lived Access JWT to JavaScript, use the following contract:

- Keep only the short-lived access token in memory; do not put it in localStorage, sessionStorage, IndexedDB, URLs, logs or analytics.
- The host's `accessToken()` callback must obtain/refresh through the selected identity provider and return a currently valid Access JWT. The NEO transport calls it for each enrolment/request and does not implement refresh-token storage.
- The identity provider owns refresh-token rotation and interactive reauthentication. Do not invent a custom refresh protocol.
- On sign-out, call the provider's logout/revocation flow, clear the provider's in-memory token/session state, discard references to the old client/session and clear any in-memory account data. The persisted device key is a separate device identity; delete it only when the user explicitly removes/forgets that browser device.
- A 401/403 is an authentication boundary, not a network retry. The outbox must remain intact; require reauthentication before a user-initiated retry. Existing `flushOutbox()` stops on 401/403 and leaves the blocked item stored.
- Use a stable opaque account subject from the identity provider for `accountScope`; do not use an email address, display name or bearer token as the scope.

No browser sign-in, refresh, sign-out or recovery provider is configured today. The Access-cookie assertion path versus a JavaScript token callback is an explicit owner/architecture decision, not something to infer from placeholder values.

## 4. Device and account recovery

- The Worker exposes per-device revocation through `DELETE /v1/devices/{device_id}`, authorized by another active device/account session. It does not currently expose a bulk account-wide device revocation or self-service account recovery endpoint.
- If a browser profile is lost, IndexedDB is cleared, or the browser evicts the non-exportable key, the old device cannot sign with its old identity. A newly created key/device ID must be enrolled; the old server-side device record must be revoked from another authorized session.
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

The existing Tauri CSP is not a template for the browser host: it currently allows `'unsafe-inline'` scripts and broad `http:`, `https:`, `ws:`, `wss:` connections. Tightening it is a separate desktop compatibility task and must not be mixed into the browser-host policy without testing the Tauri IPC/updater/local API paths.

**Threat boundary:** a non-exportable IndexedDB `CryptoKey` prevents straightforward private-key export, but same-origin XSS can still invoke signing operations and can call a JavaScript token callback. CSP reduces injection opportunities; it does not make a compromised origin safe. Keep the origin's script supply chain small and treat every third-party script as privileged code.

## 6. Tests and what they prove

- Worker CI on the inspected PR head passed TypeScript, OpenAPI lint, Wrangler dry-run, 50 Vitest tests and the native Playwright IndexedDB suite: 9/9 across Chromium, Firefox and WebKit.
- The Playwright suite validates browser CryptoKey persistence, encrypted cache recovery and ciphertext outbox replay. It does not validate a real Access login, production CSP headers, CORS, account recovery or real host origins.
- A focused Vitest regression asserts the host token callback is invoked for every request and returned tokens are absent from IndexedDB; that earlier test passed in the 51/51 Worker run on `dc45f8a...`.
- A new Worker integration test verifies that the Access-injected assertion is accepted using the same JWT verifier and that an invalid assertion cannot fall back to a valid bearer token. Its result is pending CI on the implementation commit.
- No live-host CSP/authentication test or independent penetration test has been performed.

## 7. Owner decisions and morning gates

1. Choose the NEO browser hostname and hosting provider; confirm who controls DNS/TLS and response headers.
2. Approve the recommended Cloudflare Access cookie/assertion browser flow, or explicitly choose a supported token-provider flow that can issue the exact JWT the Worker validates.
3. Choose same-origin Worker routing or approve the exact separate-origin CORS policy.
4. Only then authorize disposable Cloudflare staging, create the Access application and isolated D1, fill the real issuer/audience/database values, apply migrations 0001–0008, and run remote smoke tests.
5. Rehearse Worker rollback and D1 backup/restore only in disposable staging.
6. Separately complete Android emulator results and physical Pixel/Samsung device recovery tests with the owner present.

No Cloudflare resources, DNS, secrets, provider credentials or production services were changed for this decision record. Phase 1 remains open.
