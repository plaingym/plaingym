#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Shared host setup for the gym and demo installers: Docker, unattended
# security updates, a firewall that keeps SSH open, and swap. Safe to repeat.
set -eu
HOST_SOURCE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/lib.sh
. "$HOST_SOURCE/lib.sh"
[ "$(id -u)" -eq 0 ] || fail 'Run host setup as root.'

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl ufw unattended-upgrades age
if ! docker compose version >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  # shellcheck source=/dev/null
  . /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades
# Preserve the configured SSH listener, including a nonstandard port.
ssh_ports=$(/usr/sbin/sshd -T | awk '$1 == "port" {print $2}')
[ -n "$ssh_ports" ] || fail 'Could not determine SSH port; firewall was not enabled.'
for ssh_port in $ssh_ports; do ufw allow "$ssh_port/tcp"; done
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
if ! swapon --noheadings --show | grep -q .; then
  [ ! -e /swapfile.plaingym ] || fail 'Existing /swapfile.plaingym is inactive; inspect it before retrying.'
  fallocate -l 1G /swapfile.plaingym
  chmod 0600 /swapfile.plaingym
  mkswap /swapfile.plaingym
  swapon /swapfile.plaingym
  printf '/swapfile.plaingym none swap sw 0 0\n' >> /etc/fstab
fi
