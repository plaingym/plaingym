#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises installer and bootstrap control flow with a command fixture: input
# and DNS checks before any host change, convergent re-runs, and bundle checks.
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
printf '203.0.113.5 gym.localhost other.localhost\n192.0.2.10 elsewhere.localhost\n' > "$HOSTS"
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$temporary/bin/$1"; chmod 0700 "$temporary/bin/$1"; }
for command in apt-get systemctl ufw fallocate mkswap; do stub "$command" "printf '$command %s\n' \"\$*\" >> \"\$CALLS\""; done
stub swapon 'echo /swapfile partition 1G 0B -2'
stub openssl 'echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
stub ip 'echo "1: lo    inet 127.0.0.1/8 scope host lo"; echo "2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0"'
# The stub's own variables expand when it runs, not here.
# shellcheck disable=SC2016
stub getent '[ "$1" != -s ] || shift 2; awk -v name="$2" '"'"'{ for (i = 2; i <= NF; i++) if ($i == name) print $1 "  STREAM " name }'"'"' "$HOSTS"'
cat > "$temporary/bin/curl" <<'MOCK'
#!/bin/sh
for argument in "$@"; do last=$argument; done
case "$last" in
  https://api.ipify.org|https://api6.ipify.org) exit 22 ;;
  */api/setup) printf '%s' "${SETUP_STATUS:-200}" ;;
  */healthz) exit 0 ;;
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

expect_refusal --hostname does-not-exist.invalid --email owner@example.org
expect_refusal --hostname elsewhere.localhost --email owner@example.org
[ ! -e "$root" ]
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
# This source has no release signing key; update.sh --patch then skips each night until one is installed.
[ ! -e "$root/release-signing.pem" ]
hashes() { sha256sum "$root/.env" "$root/compose.yaml" "$root/Caddyfile" "$root/update.sh"; }
before=$(hashes)

: > "$CALLS"
install_gym --hostname gym.localhost --email owner@example.org
[ "$before" = "$(hashes)" ]
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

# The bootstrap verifies the bundle before extracting or installing anything.
bundle="$temporary/bundle"
mkdir -p "$bundle/deploy/postgres" "$bundle/deploy/images" "$bundle/deploy/systemd"
for file in compose.yaml Caddyfile lib.sh host.sh install.sh update.sh rotate-key.sh postgres/01-roles.sh systemd/plaingym-update.service systemd/plaingym-update.timer; do cp "$source_dir/$file" "$bundle/deploy/$file"; done
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
echo 'PASS: input and DNS checks before host changes, convergent re-runs, refused mismatches, verified bundles.'
