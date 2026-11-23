<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Behind Cloudflare's proxy

If your domain is on Cloudflare, put the server behind its proxy (the orange cloud) from
the start. Floods and TLS are then handled at Cloudflare's edge, and the server's address
never appears in public DNS. The installer needs no option for it. Without Cloudflare, use
a DNS-only record: any other proxy fails the installer's DNS check.

## Set it up

1. In Cloudflare, make the DNS record **Proxied** (orange cloud), and under **SSL/TLS**
   choose **Full (strict)**. **Always Use HTTPS** can stay on: the server gets its
   certificate from Let's Encrypt through the proxy, over plain HTTP on
   `/.well-known/acme-challenge/`, and Cloudflare doesn't redirect that path. Don't add a
   redirect or rule of your own for it.
2. [Run the installer](install.md#4-run-the-installer) as usual. Its DNS check recognizes
   Cloudflare's addresses (`deploy/cloudflare-ranges.txt`) and writes
   `TRUST_CLOUDFLARE=true` to `.env`, so the app reads each visitor's address from
   Cloudflare's `CF-Connecting-IP` header, but only on requests that arrive from
   Cloudflare's published ranges. Rate limits and sign-in limits then count real visitors,
   not Cloudflare's edge.
3. **Add a rate-limiting rule in Cloudflare** (Security → WAF → Rate limiting rules; the
   free plan includes one): match your hostname and exclude static assets (expression
   `(http.host eq "gym.example.org" and not starts_with(http.request.uri.path, "/assets/"))`),
   count requests per IP, and block an address that sends more than 50 matching requests
   in 10 seconds, for 10 seconds. Path matching works on the free plan. The proxy alone
   passes a single noisy client on to your server; this rule refuses it at the edge.
   Keep the `/assets/` exclusion: a cold load after an update fetches new hashed files.
   The app answers a request for a static file (a path with an extension, such as
   `/assets/…` or `/icon-192.png`) that carries a query string (`?…`) with 404 without
   reading the file, and counts it toward its own flood limit, so a query string can't be
   used to get past Cloudflare's cache to your server. A few pages the app builds itself,
   such as the website's theme stylesheet, take a version query and are answered by their
   own routes.
   The current build serves the same HTML for admin, portal and kiosk: each shell loads
   32 declared resources (entry script, preloaded chunks and stylesheet), all under
   `/assets/`. Including the HTML, that is 33 requests, of which this rule counts only
   1, before API calls, route imports, PWA files and browser icons. The web build prints
   these counts and fails if HTML plus declared resources outside `/assets/` reach 25,
   leaving room below the 50-request limit for runtime traffic. This is a shell budget,
   not a measurement of every request made during a visit.
   Members on the gym's Wi-Fi share one address, so if they get
   blocked before a busy class, raise it (100 in 10 seconds, say). A blocked visitor gets
   Cloudflare's plain `error code: 1015` page (HTTP 429) until the block ends; in the app,
   the screen shows its usual error and works again when retried.

Proxy the record before the first install rather than after, so the address never appears
in public DNS.

## If something is wrong

If the certificate isn't issued, check that the record is proxied, SSL/TLS is Full (strict)
and no rule of yours redirects or blocks `/.well-known/acme-challenge/`; then on the server
run `cd /opt/plaingym` and `sudo docker compose logs caddy`. Caddy first tries a TLS check
that Cloudflare's proxy can't pass, so a `Cannot negotiate ALPN protocol "acme-tls/1"` line
in its log is expected.

If the installer says the hostname answered with an HTTP error, a Cloudflare security
setting (Bot Fight Mode, Under Attack mode, a WAF or rate-limiting rule) may be challenging
it: allow `/.well-known/plaingym-origin` and run the installer again with the same options.
The server is installed either way; only the setup link waits for that check.

## If you proxy the record after installing

Run the installer again with the same options, so the app trusts Cloudflare's header; until
then every visitor counts as one of Cloudflare's addresses for rate limits. An install whose
`compose.yaml` and Caddyfile predate proxy support refuses that re-run until you copy both
from the current deployment files. When Cloudflare's published ranges change, a release
updates both pinned lists.

## Limits

The server also accepts connections that don't come through the proxy, so someone who
learns its address can reach it directly, around Cloudflare's protections. Cloudflare's
ranges are shared by every Cloudflare customer, so traffic sent from inside Cloudflare's
network can set `CF-Connecting-IP` itself and get around per-address limits (not sign-in
itself, and not the per-account sign-in limit). Keep the server's address private.
