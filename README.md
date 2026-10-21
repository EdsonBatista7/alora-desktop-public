# Alora Desktop

Alora Desktop is a small, open-source Windows companion that runs text-generation tasks on the user's computer. The user signs in with ChatGPT in their browser, and the app calls OpenAI's public Responses API directly with that local session. The Alora server only queues brand-scoped text work and receives the final response; it never receives a ChatGPT access or refresh token.

## User setup

1. Install Alora Desktop and open it.
2. In Alora, open **Profile → Local executor**, create a temporary pairing code, and paste it into the desktop app.
3. Choose **Continue with ChatGPT**, review the OpenAI permission screen, and return to Alora Desktop.
4. Enable the local executor. Each task uses the exact model and reasoning effort configured for its Alora employee. The computer runs it only when that model is present in the connected account's catalog; it never substitutes a different local model.

The pairing code expires after ten minutes and works once. The desktop device token and all OAuth credentials are stored together using Electron `safeStorage` (Windows DPAPI). Signing out attempts to revoke the renewable session and clears its local copy. The callback page confirms success only after the app validates and saves the account. A temporary model-catalog failure preserves that authenticated account and the app retries automatically.

## Prospecting email queue (0.1.7)

Some new Microsoft 365 tenants reject mail submitted from cloud servers (`550 5.7.708 … traffic not accepted from this IP`) while accepting the same account's mail sent from the user's own connection. When a brand's daily routine is set to **"You, through Alora Desktop"**, Alora prepares each prospecting email and keeps it in a queue instead of sending it. The paired app lists that queue; the user selects messages, sets a maximum and an interval, and sends them.

For each message the app asks Alora to prepare it: Alora re-checks suppression and lead stage, reserves the daily quota, builds the final text (signature and unsubscribe footer) and hands over a short-lived OAuth token limited to `SMTP.Send` for the connected mailbox. The app delivers it from this computer through `smtp.office365.com:587` (STARTTLS + `AUTH XOAUTH2`) and reports the result, so Alora records history, cadence and lead stage exactly as in automatic sending. One message at a time, with the chosen interval; a Microsoft rejection of the sender (5.7.x) stops the batch. A connection lost after the message body is reported as uncertain and is never resent automatically. The token is used only in memory for that message and is not stored.

## Automatic sending (0.1.8)

With **Send automatically** on, the app checks the queue every five minutes while it is running (it can stay minimized, and it opens with Windows, minimized) and sends what is waiting, one message at a time with the chosen interval (90 s by default), Monday to Friday from 8 am to 6 pm. Alora still reserves the daily quota and the mailbox warm-up for every message; when it answers that today's limit is reached, the app rests until the next day. A Microsoft rejection of the sender (5.7.x) stops sending for the day. Turning it off returns to the manual queue.

## Boundaries

- Text tasks, tool calls and inline image inputs (for example, a post written from an uploaded photo) are supported. Image generation continues through the existing Alora provider path.
- Up to three tasks run in parallel. The app keeps polling while it works, so Alora knows it is online and only hands it a task when a slot is free.
- A task reaches the computer only while the app is running, online, paired, and enabled. Otherwise Alora falls back to its configured provider.
- If an employee model is absent from the connected account catalog, this computer does not dispatch the task. The Central router decides whether another configured route can handle it; the desktop never switches to a different local model. Interrupted or ambiguous requests are not replayed.
- The catalog is a model selector, not proof that a request is entitled to run. Only a completed Responses API turn with usable output counts as success. Unknown models expose only their default reasoning effort; known GPT families expose their documented choices.
- The signed-in user's ChatGPT plan limits are shared with their other apps. The Alora connection is per user and per computer, not an organization-wide pool.

## Development

Install the pinned dependencies with `npm ci`, run `npm start`, and package a Windows x64 installer with `npm run dist:win` on a Windows host. Trusted releases require a code-signing certificate configured through `WIN_CSC_LINK`/`CSC_LINK` and `CSC_KEY_PASSWORD`; the private key must never be committed. The signed build fails when signing is unavailable and verifies Authenticode and a timestamp before succeeding. `npm run dist:win:web:unsigned` creates the small, unsigned web installer used for downloads: it fetches the full application package during setup, so the computer must be online. The larger offline preview is built with `npm run dist:win:unsigned`. Windows SmartScreen and some browsers may warn because the web installer has no Authenticode publisher signature; download only from Alora's official profile and verify the SHA-256 checksum shown there. The app deliberately has no Node.js or developer-tools access from its renderer.

Networking uses Electron's Chromium stack, including its configured proxy and trusted system certificates. TLS verification remains enabled. This avoids Node's separate CA bundle rejecting an HTTPS-inspection certificate trusted by the user's Windows browser. Run `npm test` for the callback, token-validation, persistence and recovery tests, or `npm run test:network` to check OpenAI connectivity without sending credentials.

## OpenAI flow

This app uses Sign in with ChatGPT's open-source client registration and public Responses API flow, including PKCE, nonce/state validation, OpenID token verification, the `chatgpt.tokens.use.direct` permission, `store: false`, and streamed completion verification. See OpenAI's [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [account session security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) documentation.
