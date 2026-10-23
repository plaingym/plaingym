<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Kiosk device authentication

The settings section registers devices, displays a random 256-bit bearer once, and revokes access. Only lowercase SHA-256 hashes enter the database. List/revoke responses and audits contain public device metadata only. Authentication checks revocation in a short gym-scoped transaction on every request; there is no token cache.

Integration: export `createKioskAuthMiddleware` from `devices.auth.ts`. After gym resolution, wrap the existing session middleware with `createKioskAuthMiddleware({ session, ...clientIpOptions })` as the app's session middleware. Alternatively dispatch this wrapper for `/api/kiosk/*` and the existing session middleware elsewhere. Do not run session middleware again after the wrapper: it replaces the principal. Preserve the app's CSRF, flood limiter, and route authorization middleware.

Only the exact POST contracts `lookup`, `checkinNamePin`, and `checkinQr` accept bearer authentication. Any other request with an Authorization header returns 404 when passed through this wrapper. Requests without that header delegate to the supplied session middleware, so staff can manage devices normally.

PIN lookup and name/PIN submission share independent per-device and per-client-address fixed-window limits (10 failed attempts per minute each). An in-flight request reserves a slot before verification. The check-in service signals a uniquely verified household PIN through `markKioskPinVerified`, releasing only that request's slot when it completes, even if standing sends the member to the front desk. Earlier failures remain counted; HTTP success or a neutral response alone never releases a slot. Valid family/session selections therefore do not exhaust the failed-PIN budget. QR requests do not consume PIN attempts. Client addresses use the core trusted-proxy resolver; arbitrary forwarding headers are ignored. Buckets are bounded and fail closed at capacity. These limits are process-local, like the core flood limiter; multiple processes each enforce their own budget. Reuse one middleware instance, and pass the same trusted proxy configuration as the session and app limiters.

The check-in handlers themselves are supplied by their own kiosk parts. Middleware tests use contract-shaped handlers until those implementations are available.

The production runtime mounts this wrapper ahead of session loading. Activity
updates `last_seen_at` at most once per minute using a conditional write; routine
authenticated requests do not add audit rows. Registration and revocation remain audited.
