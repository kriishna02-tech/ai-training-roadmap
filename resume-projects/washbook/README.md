# WashBook — Hostel Washing Machine Booking

React + Firebase application for live machine availability, Google sign-in, immediate timed reservations, one 15-minute extension, maintenance, discrepancy reports, and administrator reconciliation. Firestore transactions execute in callable Cloud Functions; browser clients have read-only access under Firestore security rules.

## Try the interface immediately

Requires Node.js 24+.

```bash
npm ci
npm run dev
```

Open `http://localhost:5173` and choose **Explore the demo**. Demo mode stores sample data in your browser and visibly labels itself. Reserve an available machine, extend/finish your session, inspect history, or switch to the admin demo to resolve sessions and manage maintenance. It requires no cloud account. The demo is a UI walkthrough; the Firebase backend provides the real shared reservation guarantee.

## Run the real backend locally

Install Java 21+ for the Firestore emulator. Create `.env` from `.env.example` and set:

```dotenv
VITE_DEMO_MODE=false
VITE_USE_EMULATORS=true
```

In separate terminals:

```bash
npm run emulators
# PowerShell: $env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
# macOS/Linux: export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
npm run seed
npm run dev
```

The emulator login creates a local anonymous development user. The production login uses Google authentication. The UI at `http://localhost:4000` shows emulator users and data. To make your emulator user an administrator, set `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` and run:

```bash
node functions/scripts/set-admin.mjs YOUR_EMULATOR_UID demo-washbook
```

Sign out/in after changing claims. Production roles can only be assigned with a privileged Admin SDK identity; changing a browser document never grants admin access.

## Tests and build

```bash
npm test
npm run test:emulator
npm run test:full-emulator
npm run build
```

The emulator tests race different residents for one machine, race one resident for two machines, reject stale/repeated extensions, reclaim expired reservations, verify idempotent retry, prevent a stale session from releasing a newer one, and test owner/admin authorization. The rules suite attempts direct client writes, privilege escalation, and access to another resident's sessions. The full suite also exercises the Firebase web SDK against the exported callable HTTPS handlers served on a local TCP port, with real token verification against the Auth emulator. It does not require the Functions emulator's Unix-socket transport. `npm run emulators` starts the standard Functions emulator for interactive development.

## Deploy to your Firebase project

1. Create a Firebase project, enable Firestore and Google sign-in, and add your site domain to Authentication's authorized domains.
2. Set the Firebase web configuration in `.env`; set both `VITE_DEMO_MODE=false` and `VITE_USE_EMULATORS=false`. Web configuration is not an Admin SDK credential. Never place a service-account key in the browser or Git.
3. Use Node 24, log in through `npx firebase login`, and select your project with `npx firebase use --add`.
4. Run `npm run build`, then `npx firebase deploy --only firestore,functions,hosting --project YOUR_PROJECT_ID`.
5. Create machine documents matching the seed schema through a privileged Admin SDK or Firestore console. The seed script deliberately refuses to write to production. Grant the administrator custom claim with the Admin SDK script using your explicit project ID and Application Default Credentials.

Cloud Functions and the scheduled expiry task require a Firebase billing-enabled project. No cloud resource is created and no paid service is enabled by cloning or running the local demo. Live deployment and Google sign-in are unverified until a real project is configured.

## Reservation invariants

- Machine, session, and user lease change in one server transaction.
- Machine version checks reject old snapshots. Session version checks prevent concurrent stale extensions or finish calls.
- A user lease enforces one active reservation per resident, even across different machines.
- The server's time determines eligibility. The browser clock only renders a countdown.
- Expired reservations can be reclaimed during the next transaction. A scheduled task also releases them every minute.
- Request IDs make retries idempotent; reuse for a different operation is rejected. Request-cache documents include `expiresAt`. Configure a Firestore TTL policy on that field to prune them automatically if desired.
- Administrator machine updates and report resolutions include audit records and reasons.
- Direct browser writes are denied, including for administrators. Admin reads use a signed custom claim, and all mutations pass through callable functions.

All Firestore transaction reads precede their writes. This avoids the SDK's read-after-write rejection while maintaining a consistent view of ownership and expiry.

References: [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions), [callable functions](https://firebase.google.com/docs/functions/callable), [security rules](https://firebase.google.com/docs/firestore/security/get-started).
