# NEO browser Alpha

This is the first browser chat shell for NEO. It uses the existing `NeoDeviceClient` for account-scoped IndexedDB identity, Cloudflare Access session bootstrap, device enrolment, signed device requests, heartbeat and chat completions.

## Local build

Requires Node.js 22+.

```sh
npm install
npm run dev
npm run build
```

For staging, build this web package before running Wrangler from `infra/cloudflare` so `clients/web/dist` exists.

## Runtime prerequisites

- The initial Alpha expects the UI and API to share one origin. The disposable Wrangler template serves the built `dist` directory as Worker assets and sends `/v1/*` through the Worker.
- Protect the app origin and `/v1/*` with the same Cloudflare Access application.
- Route `/v1/*` to the NEO Worker.
- Configure the Cloudflare Access issuer and audience on the Worker.
- Apply the D1 migrations and configure a positive, reviewed provider spend budget, token budgets, provider pricing and output cap before enabling paid chat.
- Keep provider API keys in Worker secrets only. Never put them in this app.

The browser uses the Access-protected `/v1/session` bootstrap to obtain the account scope, then creates or reuses a non-exportable P-256 WebCrypto device key in IndexedDB and enrols it. It does not store the Access assertion or provider key.

## Current Alpha limitations

- Chat history is in page memory only and is cleared on reload; persistent encrypted conversation memory is not yet wired into this UI.
- No streaming responses, voice UI, task runner or cross-device conversation display yet.
- Provider requests remain blocked until the Worker has a configured provider, reviewed pricing and non-zero spend/token limits.
- No staging URL is available until disposable Cloudflare resources are explicitly approved and provisioned.
