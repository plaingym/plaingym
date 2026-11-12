#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises installer and bootstrap control flow with a command fixture: input
# and DNS checks before any host change, convergent re-runs, bundle checks, and
# release bootstraps that verify a signed local release before installing it.
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
[ "$(id -u)" -eq 0 ] || { echo 'Run this test as root in a disposable environment.' >&2; exit 1; }
[ -x /usr/sbin/sshd ] || { echo 'host.sh reads the SSH port from /usr/sbin/sshd -T.' >&2; exit 1; }
# sshd -T needs the privilege separation directory that a running sshd creates.
install -d -m 0755 /run/sshd
temporary=$(mktemp -d)
cleanup() {
  status=$?
  # On a failed check, show the last installer output instead of exiting silently.
  if [ "$status" -ne 0 ] && [ -f "$temporary/output" ]; then cat "$temporary/output" >&2; fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
mkdir "$temporary/bin"
export PATH="$temporary/bin:$PATH" CALLS="$temporary/calls" HOSTS="$temporary/hosts" STATE="$temporary/state"
# The update timer's units go here instead of /etc/systemd/system.
export SYSTEMD_UNIT_DIR="$temporary/units"
mkdir "$STATE" "$SYSTEMD_UNIT_DIR"
# 203.0.113.5 is this fixture server; 192.0.2.10 is someone else's.
printf '203.0.113.5 gym.localhost other.localhost\n192.0.2.10 elsewhere.localhost\n127.0.0.1 loopback.invalid\n203.0.113.6 nat.invalid\n2001:db8::6 nat6.invalid\n2001:db8::10 elsewhere6.invalid\n' > "$HOSTS"
printf '203.0.113.20 api.ipify.org\n2a01:4f8::1 mixed.invalid\n49.12.0.9 mixed.invalid\n2001:db8::10 mixed-reverse.invalid\n192.0.2.10 mixed-reverse.invalid\n' >> "$HOSTS"
printf '203.0.113.6 multi4.invalid\n192.0.2.10 multi4.invalid\n2001:db8::6 multi6.invalid\n2001:db8::10 multi6.invalid\n192.0.2.10 foreign4.invalid\n192.0.2.11 foreign4.invalid\n2001:db8::10 foreign6.invalid\n2001:db8::11 foreign6.invalid\n2001:db8:0:1:2:3:4:6 full6.invalid\n' >> "$HOSTS"
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$temporary/bin/$1"; chmod 0700 "$temporary/bin/$1"; }
for command in apt-get systemctl ufw fallocate mkswap; do stub "$command" "printf '$command %s\n' \"\$*\" >> \"\$CALLS\""; done
# Cloudflare proxy addresses (deploy/cloudflare-ranges.txt) for a proxied hostname.
printf '104.16.1.1 proxied.invalid\n2606:4700::1111 proxied.invalid\n' >> "$HOSTS"
stub swapon 'echo /swapfile partition 1G 0B -2'
# The installer's HTTPS retries wait in between; the fixture answers at once.
stub sleep ':'
# The release bootstrap's checks need the real OpenSSL, so only random values are stubbed.
real_openssl=$(command -v openssl)
stub openssl "case \"\$1\" in genpkey|pkey|pkeyutl) exec '$real_openssl' \"\$@\" ;; esac; echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
# shellcheck disable=SC2016
stub ip 'echo "1: lo    inet 127.0.0.1/8 scope host lo"; echo "2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0"; echo "2: eth0    inet6 fe80::5/64 scope link"; echo "2: eth0    inet6 fd00::5/64 scope global eth0"; echo "2: eth0    inet6 20::5/64 scope global eth0"; if [ "${GLOBAL6:-false}" = true ]; then echo "2: eth0    inet6 2001:db8::5/64 scope global eth0"; fi'
# The stub's own variables expand when it runs, not here.
# shellcheck disable=SC2016
stub getent '[ "$1" != -s ] || shift 2; status=0; awk -v name="$2" '"'"'{ for (i = 2; i <= NF; i++) if ($i == name) { print $1 "  STREAM " name; found=1 } } END { if (!found) exit 2 }'"'"' "$HOSTS" || status=$?; exit "${DNS_STATUS:-$status}"'
cat > "$temporary/bin/curl" <<'MOCK'
#!/bin/sh
for argument in "$@"; do last=$argument; done
case "$last" in
  # A release's assets, from the local release directory; -o names the file to write.
  https://github.com/release-test/plaingym/releases/download/*)
    previous=; for argument in "$@"; do [ "$previous" != -o ] || out=$argument; previous=$argument; done
    file="$RELEASES/${last#https://github.com/release-test/plaingym/releases/download/}"
    [ -f "$file" ] || exit 22
    cp "$file" "$out" ;;
  https://api.ipify.org) echo 'public lookup 4' >> "$CALLS"; printf '%s' "${PUBLIC4-203.0.113.6}"; exit "${PUBLIC4_STATUS:-0}" ;;
  https://api6.ipify.org) echo 'public lookup 6' >> "$CALLS"; printf '%s' "${PUBLIC6-2001:db8::6}"; exit "${PUBLIC6_STATUS:-0}" ;;
  */api/setup) printf '%s' "${SETUP_STATUS:-200}" ;;
  # The openssl stub makes every install's origin value this one; WRONG_ORIGIN is a hostname fronting another server.
  # The installer asks for the body and then the status on its own line; ORIGIN_STATUS is a Cloudflare challenge.
  */.well-known/plaingym-origin)
    printf 'origin %s\n' "$*" >> "$CALLS"
    if [ -n "${ORIGIN_STATUS:-}" ]; then printf 'challenge page\n%s' "$ORIGIN_STATUS"
    elif [ "${WRONG_ORIGIN:-false}" = true ]; then printf 'another-server\n200'
    else printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n200'; fi ;;
  */healthz) printf 'ok\n%s' "${HEALTH_STATUS:-200}" ;;
  *) exit 22 ;;
esac
MOCK
cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
printf 'docker %s\n' "$*" >> "$CALLS"
case "$*" in
  'compose version') exit 0 ;;
  'image inspect '*) [ -f "$STATE/loaded" ] ;;
  'load -i '*) : > "$STATE/loaded" ;;
  *' exec -T app gym-app setup-link') echo 'https://gym.localhost/setup#token=fixture' ;;
esac
MOCK
chmod 0700 "$temporary/bin/curl" "$temporary/bin/docker"
: > "$temporary/image.tar"
root="$temporary/install"
install_gym() { sh "$source_dir/install.sh" --directory "$root" --image plaingym:v0.0.0-local --image-archive "$temporary/image.tar" "$@" > "$temporary/output" 2>&1; }
expect_refusal() {
  : > "$CALLS"
  if install_gym "$@"; then echo "Expected a refusal: $*" >&2; exit 1; fi
  grep -q 'Nothing was changed' "$temporary/output"
  if grep -Eq '^(apt-get|ufw|systemctl|docker load)' "$CALLS"; then echo "Host changed before refusing: $*" >&2; exit 1; fi
}

expect_dns_refusal() {
  expect_refusal --hostname "$1" --email owner@example.org
  grep -qF "$2" "$temporary/output"
  grep -qF 'cached answers can remain until their TTL expires, which can take an hour or more' "$temporary/output"
  grep -qF 'retry the installer after that' "$temporary/output"
  [ ! -e "$root" ]
}
expect_dns_refusal does-not-exist.invalid 'does not resolve yet'
expect_dns_refusal missing.localhost 'does not resolve yet'
expect_dns_refusal elsewhere.localhost 'which is not this server'
expect_dns_refusal loopback.invalid 'resolves to a loopback address'
expect_lookup_refusal() {
  expect_refusal --hostname "$1" --email owner@example.org
  grep -qF "$2" "$temporary/output"
  case "$2" in
    *'could not query DNS') grep -qF "Check the server's DNS resolver and network connectivity" "$temporary/output" ;;
    *) grep -qF 'Check that curl is installed and outbound HTTPS works with no filtering proxy or captive portal in the way' "$temporary/output" ;;
  esac
  if grep -Eq 'TTL|does not resolve yet|which is not this server' "$temporary/output"; then
    echo 'A failed lookup was reported as a DNS mismatch or told the owner to wait.' >&2
    exit 1
  fi
  [ ! -e "$root" ]
}
# Nonzero getent status must survive, even if it printed an address first.
DNS_STATUS=2 expect_lookup_refusal does-not-exist.invalid 'This server could not query DNS'
DNS_STATUS=2 expect_lookup_refusal gym.localhost 'This server could not query DNS'
PUBLIC4_STATUS=22 expect_lookup_refusal nat.invalid 'The public-address lookup failed'
GLOBAL6=true PUBLIC6_STATUS=22 expect_lookup_refusal nat6.invalid 'The public-address lookup failed'
PUBLIC6_STATUS=22 expect_dns_refusal elsewhere6.invalid 'Remove the AAAA record or configure working public IPv6'
PUBLIC4='' expect_lookup_refusal nat.invalid 'The public-address lookup failed'
# HTTP 200 pages from a proxy, malformed or repeated addresses, and the wrong family do not
# confirm a public address or turn a lookup failure into a DNS mismatch.
twice() { printf '%s\n%s' "$1" "$1"; }
for body in '<html>proxy login</html>' '999.0.113.6' '2001:db8::6' "$(twice 203.0.113.6)"; do
  PUBLIC4="$body" expect_lookup_refusal nat.invalid 'The public-address lookup failed'
done
for body in '<html>proxy login</html>' '2001::db8::6' '203.0.113.6' "$(twice 2001:db8::6)"; do
  GLOBAL6=true PUBLIC6="$body" expect_lookup_refusal nat6.invalid 'The public-address lookup failed'
done
# Multiple nonlocal answers reuse the same family lookup, including a mismatch
# followed by this server's public address.
expect_dns_refusal multi4.invalid 'which is not this server'
[ "$(cat "$CALLS")" = 'public lookup 4' ]
expect_dns_refusal multi6.invalid 'which is not this server'
[ "$(cat "$CALLS")" = 'public lookup 6' ]
# Two answers that both miss the lookup's result still make one request, and so
# does a failed lookup: neither is retried for the family's next answer.
expect_dns_refusal foreign4.invalid 'which is not this server'
[ "$(cat "$CALLS")" = 'public lookup 4' ]
PUBLIC4_STATUS=22 expect_lookup_refusal foreign4.invalid 'The public-address lookup failed'
[ "$(cat "$CALLS")" = 'public lookup 4' ]
expect_dns_refusal foreign6.invalid 'which is not this server'
[ "$(cat "$CALLS")" = 'public lookup 6' ]
GLOBAL6=true PUBLIC6_STATUS=22 expect_lookup_refusal foreign6.invalid 'The public-address lookup failed'
[ "$(cat "$CALLS")" = 'public lookup 6' ]
# Missing curl has the same diagnostic, without relying on the container's packages.
mkdir "$temporary/no-curl"
for command in getent ip awk sort grep; do ln -s "$(command -v "$command")" "$temporary/no-curl/$command"; done
if PATH="$temporary/no-curl" /bin/sh -c 'set -eu; . "$1"; check_dns nat.invalid' sh "$source_dir/lib.sh" > "$temporary/output" 2>&1; then exit 1; fi
grep -qF 'The public-address lookup failed' "$temporary/output"
grep -qF 'Check that curl is installed and outbound HTTPS works with no filtering proxy or captive portal in the way' "$temporary/output"
grep -qF 'Nothing was changed' "$temporary/output"
# A failed lookup in the other address family must not hide a confirmed mismatch.
PUBLIC6_STATUS=22 expect_dns_refusal elsewhere.localhost 'which is not this server'
PUBLIC4_STATUS=22 expect_dns_refusal elsewhere6.invalid 'which is not this server'
# Both answers belong to the same name; the unconfirmed IPv6 answer sorts first.
GLOBAL6=true PUBLIC6_STATUS=22 expect_dns_refusal mixed.invalid '49.12.0.9, which is not this server'
GLOBAL6=true PUBLIC4_STATUS=22 expect_dns_refusal mixed-reverse.invalid '2001:db8::10, which is not this server'
# With no confirmed mismatch, an unconfirmed address still explains the lookup failure.
GLOBAL6=true PUBLIC4_STATUS=22 PUBLIC6_STATUS=22 expect_lookup_refusal mixed.invalid 'The public-address lookup failed'
# Public addresses behind NAT and local addresses with failed public lookups still pass.
check_dns_only() { sh -c 'set -eu; . "$1"; check_dns "$2"' sh "$source_dir/lib.sh" "$1"; }
: > "$CALLS"
check_dns_only nat.invalid
[ "$(cat "$CALLS")" = 'public lookup 4' ]
: > "$CALLS"
GLOBAL6=true check_dns_only nat6.invalid
[ "$(cat "$CALLS")" = 'public lookup 6' ]
# An uncompressed eight-group address is the usual form on a real server.
PUBLIC6=2001:db8:0:1:2:3:4:6 check_dns_only full6.invalid
: > "$CALLS"
PUBLIC4_STATUS=22 PUBLIC6_STATUS=22 check_dns_only gym.localhost
[ ! -s "$CALLS" ]
# The timer's unit names the directory, so odd characters are refused before anything changes.
: > "$CALLS"
if sh "$source_dir/install.sh" --directory "$temporary/with space" --image plaingym:v0.0.0-local --hostname gym.localhost --email owner@example.org > "$temporary/output" 2>&1; then exit 1; fi
grep -q 'Nothing was changed' "$temporary/output"
[ ! -s "$CALLS" ] && [ ! -e "$temporary/with space" ]

: > "$CALLS"
install_gym --hostname gym.localhost --email owner@example.org
[ "$(stat -c %a "$root/.env")" = 600 ]
[ "$(stat -c %a "$root/rotate-key.sh")" = 700 ]
grep -qx GYM_HOSTNAME=gym.localhost "$root/.env"
# Backups use the setup wizard's key pair; nothing reads a BACKUP_RECIPIENT line.
if grep -q BACKUP_RECIPIENT "$root/.env"; then echo 'A fresh .env names BACKUP_RECIPIENT.' >&2; exit 1; fi
grep -q '^apt-get install' "$CALLS"
grep -q '^docker load -i' "$CALLS"
grep -q 'setup#token=fixture' "$temporary/output"
# The nightly patch update timer runs this install's update.sh.
grep -qx "ExecStart=/bin/sh $root/update.sh --patch" "$SYSTEMD_UNIT_DIR/plaingym-update.service"
grep -qx "ConditionPathExists=$root/.env" "$SYSTEMD_UNIT_DIR/plaingym-update.service"
grep -qx 'OnCalendar=hourly' "$SYSTEMD_UNIT_DIR/plaingym-update.timer"
if grep -q '@ROOT@' "$SYSTEMD_UNIT_DIR"/*; then echo 'A unit kept its placeholder.' >&2; exit 1; fi
[ "$(stat -c %a "$SYSTEMD_UNIT_DIR/plaingym-update.timer")" = 644 ]
[ "$(grep -n '^systemctl daemon-reload' "$CALLS" | cut -d: -f1)" -lt "$(grep -n '^systemctl enable --now plaingym-update.timer' "$CALLS" | cut -d: -f1)" ]
grep -q 'Patch releases install automatically each night' "$temporary/output"
# The source's release signing key goes beside update.sh, readable by all; a re-run leaves it alone.
cmp "$source_dir/release-signing.pem" "$root/release-signing.pem"
[ "$(stat -c %a "$root/release-signing.pem")" = 644 ]
hashes() { sha256sum "$root/.env" "$root/compose.yaml" "$root/Caddyfile" "$root/update.sh" "$root/release-signing.pem"; }
before=$(hashes)

: > "$CALLS"
install_gym --hostname gym.localhost --email owner@example.org
[ "$before" = "$(hashes)" ]
if grep -q '^public lookup' "$CALLS"; then echo 'A local-address re-run queried a public-address service.' >&2; exit 1; fi
if grep -q '^docker load' "$CALLS"; then echo 'A re-run replaced the loaded image.' >&2; exit 1; fi
grep -q 'setup#token=fixture' "$temporary/output"
SETUP_STATUS=404 install_gym --hostname gym.localhost --email owner@example.org
grep -q 'Setup is complete. Sign in at https://gym.localhost/login' "$temporary/output"
if grep -q 'token=' "$temporary/output"; then echo 'Printed a setup link after setup.' >&2; exit 1; fi

expect_refusal --hostname other.localhost --email owner@example.org
expect_refusal --hostname gym.localhost --email someone@example.org
: > "$CALLS"
if sh "$source_dir/install.sh" --directory "$root" --hostname gym.localhost --email owner@example.org --image plaingym:v1.0.0 > "$temporary/output" 2>&1; then exit 1; fi
grep -q 'use update.sh' "$temporary/output"
[ "$before" = "$(hashes)" ]

# Cloudflare's proxy: the range check (mawk-safe), automatic detection, and the origin check before the setup link.
ranges="$source_dir/cloudflare-ranges.txt"
in_ranges() { sh -c 'set -eu; . "$1"; in_cloudflare_ranges "$2" "$3"' sh "$source_dir/lib.sh" "$1" "$ranges"; }
for address in 173.245.48.1 173.245.63.255 104.16.0.0 104.23.255.255 2606:4700::1 2a06:98c7:ffff::1 2c0f:f248::; do in_ranges "$address"; done
for address in 173.245.64.0 104.32.0.0 192.0.2.1 203.0.113.5 2a06:98c8::1 2001:db8::1 not-an-address 2606:4700::zz 2606:4700::12345 ::ffff:104.16.0.1 104.16.0.256; do
  if in_ranges "$address"; then echo "In Cloudflare's ranges by mistake: $address" >&2; exit 1; fi
done
# A DNS-only install carries its origin value and doesn't trust Cloudflare.
grep -q '^PLAINGYM_ORIGIN_NONCE=.' "$root/.env"
if grep -q TRUST_CLOUDFLARE "$root/.env"; then echo 'A DNS-only install trusts Cloudflare.' >&2; exit 1; fi
proxied="$temporary/proxied"
install_proxied() { sh "$source_dir/install.sh" --directory "$proxied" --image plaingym:v0.0.0-local --image-archive "$temporary/image.tar" --hostname proxied.invalid --email owner@example.org > "$temporary/output" 2>&1; }
: > "$CALLS"
CLOUDFLARE_RANGES="$ranges" check_dns_only proxied.invalid
if grep -q '^public lookup' "$CALLS"; then echo 'A Cloudflare address queried a public-address service.' >&2; exit 1; fi
# A proxied hostname installs with no flag, trusts the proxy, and passes the origin check through it.
: > "$CALLS"
install_proxied
grep -qx TRUST_CLOUDFLARE=true "$proxied/.env"
grep -q 'setup#token=fixture' "$temporary/output"
# The origin check connects to the address public DNS gives, not whatever /etc/hosts says.
grep -q '^origin .*--resolve proxied.invalid:443:104.16.1.1 ' "$CALLS"
grep -qx 'ufw allow 80/tcp' "$CALLS"
grep -qx 'ufw allow 443/tcp' "$CALLS"
proxied_env=$(cat "$proxied/.env")
install_proxied
[ "$(cat "$proxied/.env")" = "$proxied_env" ]
# A hostname that answers from another server gets no setup link.
: > "$CALLS"
if WRONG_ORIGIN=true sh "$source_dir/install.sh" --directory "$temporary/elsewhere" --image plaingym:v0.0.0-local --image-archive "$temporary/image.tar" --hostname proxied.invalid --email owner@example.org > "$temporary/output" 2>&1; then
  echo 'Printed a setup link for a hostname that reaches another server.' >&2; exit 1
fi
grep -qF 'answers, but not from this server, so the private setup link was not printed' "$temporary/output"
if grep -q 'token=' "$temporary/output"; then echo 'Printed a setup link after a failed origin check.' >&2; exit 1; fi
# The install is complete (its update timer is in place); only the link was withheld.
grep -qx "ExecStart=/bin/sh $temporary/elsewhere/update.sh --patch" "$SYSTEMD_UNIT_DIR/plaingym-update.service"
# A Cloudflare challenge on the check names the likely setting, not a wrong server.
if ORIGIN_STATUS=403 sh "$source_dir/install.sh" --directory "$temporary/challenged" --image plaingym:v0.0.0-local --image-archive "$temporary/image.tar" --hostname proxied.invalid --email owner@example.org > "$temporary/output" 2>&1; then exit 1; fi
grep -qF 'The private setup link was not printed' "$temporary/output"
grep -qF 'It answered HTTP 403' "$temporary/output"
grep -qF 'Bot Fight Mode' "$temporary/output"
if grep -q 'token=\|not from this server' "$temporary/output"; then echo 'A challenge was reported as another server, or printed the link.' >&2; exit 1; fi
# A challenge on /healthz fails after the update timer is in place, naming the likely setting.
if HEALTH_STATUS=503 sh "$source_dir/install.sh" --directory "$temporary/unhealthy" --image plaingym:v0.0.0-local --image-archive "$temporary/image.tar" --hostname proxied.invalid --email owner@example.org > "$temporary/output" 2>&1; then exit 1; fi
grep -qF 'the update timer is installed, but https://proxied.invalid/healthz failed' "$temporary/output"
grep -qF 'It answered HTTP 503' "$temporary/output"
grep -qx "ExecStart=/bin/sh $temporary/unhealthy/update.sh --patch" "$SYSTEMD_UNIT_DIR/plaingym-update.service"
# An empty origin value is replaced on a re-run, never compared.
printf 'PLAINGYM_ORIGIN_NONCE=\n' >> "$proxied/.env"
install_proxied
[ -n "$(sh -c '. "$1"; ROOT=$2; read_env PLAINGYM_ORIGIN_NONCE' sh "$source_dir/lib.sh" "$proxied")" ]
# An owner's own TRUST_CLOUDFLARE value stays on a proxied re-run.
sed 's/^TRUST_CLOUDFLARE=true$/TRUST_CLOUDFLARE=false/' "$proxied/.env" > "$proxied/.env.next"; mv "$proxied/.env.next" "$proxied/.env"; chmod 0600 "$proxied/.env"
install_proxied
[ "$(grep -c '^TRUST_CLOUDFLARE=' "$proxied/.env")" -eq 1 ] && grep -qx TRUST_CLOUDFLARE=false "$proxied/.env"
# A proxied re-run of an install whose files predate Cloudflare support is refused before any host change.
grep -v plaingym-origin "$proxied/Caddyfile" > "$proxied/Caddyfile.old"; cp "$proxied/Caddyfile" "$proxied/Caddyfile.current"; mv "$proxied/Caddyfile.old" "$proxied/Caddyfile"
: > "$CALLS"
if install_proxied; then echo 'Re-ran a proxied install on files without Cloudflare support.' >&2; exit 1; fi
grep -qF 'predate support for it' "$temporary/output"
if grep -Eq '^(apt-get|ufw|systemctl|docker)' "$CALLS"; then echo 'Host changed before refusing old files.' >&2; exit 1; fi
mv "$proxied/Caddyfile.current" "$proxied/Caddyfile"
# An install from before the origin value gains it, and only it, on a re-run.
grep -v '^PLAINGYM_ORIGIN_NONCE=' "$root/.env" > "$root/.env.next"; mv "$root/.env.next" "$root/.env"; chmod 0600 "$root/.env"
env_before=$(cat "$root/.env")
install_gym --hostname gym.localhost --email owner@example.org
[ "$(grep -v '^PLAINGYM_ORIGIN_NONCE=' "$root/.env")" = "$env_before" ]
grep -q '^PLAINGYM_ORIGIN_NONCE=.' "$root/.env"
[ "$(stat -c %a "$root/.env")" = 600 ]

# The bootstrap verifies the bundle before extracting or installing anything.
bundle="$temporary/bundle"
mkdir -p "$bundle/deploy/postgres" "$bundle/deploy/images" "$bundle/deploy/systemd"
for file in compose.yaml Caddyfile lib.sh host.sh install.sh update.sh rotate-key.sh cloudflare-ranges.txt postgres/01-roles.sh systemd/plaingym-update.service systemd/plaingym-update.timer; do cp "$source_dir/$file" "$bundle/deploy/$file"; done
# A bundle carries the release signing key; the installer puts it beside update.sh.
printf 'fixture public key\n' > "$bundle/deploy/release-signing.pem"
: > "$bundle/deploy/images/app.tar"
printf 'APP_IMAGE=plaingym:v0.0.0-local\nBUNDLE_ARCHITECTURE=%s\n' "$(dpkg --print-architecture)" > "$bundle/deploy/images.env"
tar -cf "$temporary/bundle.tar" -C "$bundle" deploy
sum=$(sha256sum "$temporary/bundle.tar" | cut -d' ' -f1)
rm -f "$STATE/loaded"
: > "$CALLS"
if sh "$source_dir/bootstrap.sh" --bundle-file "$temporary/bundle.tar" --sha256 "$(printf '%064d' 0)" -- --hostname gym.localhost --email owner@example.org --directory "$temporary/bootstrapped" > "$temporary/output" 2>&1; then exit 1; fi
grep -q 'does not match its SHA256' "$temporary/output"
[ ! -s "$CALLS" ] && [ ! -e "$temporary/bootstrapped" ]
sh "$source_dir/bootstrap.sh" --bundle-file "$temporary/bundle.tar" --sha256 "$sum" -- --hostname gym.localhost --email owner@example.org --directory "$temporary/bootstrapped" > "$temporary/output" 2>&1
grep -qx APP_IMAGE=plaingym:v0.0.0-local "$temporary/bootstrapped/.env"
grep -q 'setup#token=fixture' "$temporary/output"
grep -qx 'fixture public key' "$temporary/bootstrapped/release-signing.pem"
grep -qx "ExecStart=/bin/sh $temporary/bootstrapped/update.sh --patch" "$SYSTEMD_UNIT_DIR/plaingym-update.service"
case "$(dpkg --print-architecture)" in amd64) other=arm64 ;; *) other=amd64 ;; esac
printf 'APP_IMAGE=plaingym:v0.0.0-local\nBUNDLE_ARCHITECTURE=%s\n' "$other" > "$bundle/deploy/images.env"
tar -cf "$temporary/foreign.tar" -C "$bundle" deploy
: > "$CALLS"
if sh "$source_dir/bootstrap.sh" --bundle-file "$temporary/foreign.tar" --sha256 "$(sha256sum "$temporary/foreign.tar" | cut -d' ' -f1)" -- --hostname gym.localhost --email owner@example.org --directory "$temporary/foreign" > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ] && [ ! -e "$temporary/foreign" ]
if sh "$source_dir/bootstrap.sh" --bundle-url http://example.org/bundle.tar --sha256 "$sum" > /dev/null 2>&1; then exit 1; fi

# A release's bootstrap.sh installs from the release on GitHub, served here by the curl fixture from a local release
# built from this commit with a throwaway key: the deploy archive and bootstrap from deploy-assets.sh, and a manifest
# that lists the archive's SHA-256, signed as publish.sh signs it.
export RELEASES="$temporary/releases"
release="$RELEASES/v1.2.3"
mkdir -p "$release"
repository_dir=$(CDPATH='' cd -- "$source_dir/.." && pwd)
revision=$(git -c safe.directory="$repository_dir" -C "$repository_dir" rev-parse HEAD)
"$real_openssl" genpkey -algorithm ed25519 -out "$temporary/release-key.pem" 2>/dev/null
"$real_openssl" pkey -in "$temporary/release-key.pem" -pubout -out "$temporary/release-public.pem"
"$real_openssl" genpkey -algorithm ed25519 -out "$temporary/other-key.pem" 2>/dev/null
"$real_openssl" pkey -in "$temporary/other-key.pem" -pubout -out "$temporary/other-public.pem"
assets() { sh "$source_dir/release/deploy-assets.sh" --revision "$revision" --version v1.2.3 --repository release-test/plaingym --public-key "$1" --out "$2"; }
assets "$temporary/release-public.pem" "$release"
# The same assets with another key: its bootstrap.sh holds the wrong key, and its archive carries it.
assets "$temporary/other-public.pem" "$temporary/other-assets"
archive="$release/plaingym-deploy-v1.2.3.tar.gz"
digest=sha256:$(printf '%064d' 1)
sign_release() { # ARCHIVE_SHA256 [KEY]: write and sign the release's manifest
  {
    printf 'format=plaingym-release-manifest/2\nversion=v1.2.3\nimage=ghcr.io/release-test/app\ndigest=%s\nrollback_floor=v1.1.0\n' "$digest"
    printf 'digest.linux/amd64=sha256:%064d\ndigest.linux/arm64=sha256:%064d\n' 2 3
    printf 'deploy_archive=plaingym-deploy-v1.2.3.tar.gz\ndeploy_archive_sha256=sha256:%s\n' "$1"
    printf 'revision=%s\nmigrations=sha256:%064d\nreleased=2026-11-12T00:00:00Z\n' "$revision" 4
  } > "$release/release-manifest.txt"
  "$real_openssl" pkeyutl -sign -inkey "${2:-$temporary/release-key.pem}" -rawin -in "$release/release-manifest.txt" -out "$release/release-manifest.txt.sig"
}
archive_sum=$(sha256sum "$archive" | cut -d' ' -f1)
sign_release "$archive_sum"
# update.sh's own checks (lib.sh) accept the manifest a bootstrap installs from.
# shellcheck source=deploy/lib.sh
(. "$source_dir/lib.sh"; manifest_verify "$temporary/release-public.pem" "$release/release-manifest.txt" "$release/release-manifest.txt.sig" && manifest_check "$release/release-manifest.txt" v1.2.3)
# bootstrap_release BOOTSTRAP DIRECTORY [ARGS]: the one command an owner runs, with this fixture's install directory.
bootstrap_release() { script=$1; directory=$2; shift 2; sh "$script" --hostname gym.localhost --email owner@example.org --directory "$directory" "$@" > "$temporary/output" 2>&1; }
expect_bootstrap_refusal() { # MESSAGE BOOTSTRAP [ARGS]
  message=$1; script=$2; shift 2
  : > "$CALLS"
  if bootstrap_release "$script" "$temporary/refused" "$@"; then echo "Bootstrap accepted, expected: $message" >&2; exit 1; fi
  grep -qF "$message" "$temporary/output" || { echo "Expected \"$message\"" >&2; exit 1; }
  grep -qF 'Nothing was changed' "$temporary/output"
  if [ -e "$temporary/refused" ] || grep -Eq '^(apt-get|ufw|systemctl|docker)' "$CALLS"; then echo "Host changed before refusing: $message" >&2; exit 1; fi
}
# A copy that isn't a release's has no key to check with; a release's copy refuses an image of the owner's choosing.
expect_bootstrap_refusal 'is not a release' "$source_dir/bootstrap.sh"
expect_bootstrap_refusal 'leave out --image' "$release/bootstrap.sh" --image plaingym:v0.0.0-local
# Another key than the one that signed the release.
expect_bootstrap_refusal 'does not verify' "$temporary/other-assets/bootstrap.sh"
# A tampered manifest.
cp "$release/release-manifest.txt" "$temporary/manifest.good"
sed 's#^image=.*#image=ghcr.io/attacker/app#' "$temporary/manifest.good" > "$release/release-manifest.txt"
expect_bootstrap_refusal 'does not verify' "$release/bootstrap.sh"
cp "$temporary/manifest.good" "$release/release-manifest.txt"
# A tampered archive.
cp "$archive" "$temporary/archive.good"
printf 'x' >> "$archive"
expect_bootstrap_refusal 'does not match the SHA-256' "$release/bootstrap.sh"
cp "$temporary/archive.good" "$archive"
# A signed manifest whose archive carries another key than the one checking it.
cp "$temporary/other-assets/plaingym-deploy-v1.2.3.tar.gz" "$archive"
sign_release "$(sha256sum "$archive" | cut -d' ' -f1)"
expect_bootstrap_refusal 'carries another release signing key' "$release/bootstrap.sh"
cp "$temporary/archive.good" "$archive"
sign_release "$archive_sum"
# A missing asset.
mv "$release/release-manifest.txt.sig" "$temporary/signature.good"
expect_bootstrap_refusal 'Could not download' "$release/bootstrap.sh"
mv "$temporary/signature.good" "$release/release-manifest.txt.sig"
# The verified release installs the manifest's image by digest, with the archive's key beside update.sh, and prints the
# setup link. It runs piped into sh, as the guide runs it, and a second run converges on the same install.
for _ in 1 2; do
  sh -s -- --hostname gym.localhost --email owner@example.org --directory "$temporary/released" < "$release/bootstrap.sh" > "$temporary/output" 2>&1
  grep -qx "APP_IMAGE=ghcr.io/release-test/app:v1.2.3@$digest" "$temporary/released/.env"
  grep -q 'setup#token=fixture' "$temporary/output"
done
cmp -s "$temporary/release-public.pem" "$temporary/released/release-signing.pem"
echo 'PASS: input and DNS checks before host changes, convergent re-runs, refused mismatches, Cloudflare proxy detection and the origin check, verified bundles, and verified releases.'
