#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
cd /cache
exec 9>/cache/download.lock
flock 9
# Save and verify the publisher's checksum, and retain both with the VM evidence.
if [ ! -f noble-server-cloudimg-amd64.img ]; then
  curl -fL --retry 3 https://cloud-images.ubuntu.com/noble/current/SHA256SUMS -o SHA256SUMS
  curl -fL --retry 3 https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img -o image.partial
  expected=$(awk '$2 == "*noble-server-cloudimg-amd64.img" || $2 == "noble-server-cloudimg-amd64.img" {print $1}' SHA256SUMS)
  test "${#expected}" -eq 64
  printf '%s  image.partial\n' "$expected" | sha256sum -c -
  mv image.partial noble-server-cloudimg-amd64.img
fi
flock -u 9
if [ ! -f /vm/disk.qcow2 ]; then
  qemu-img create -f qcow2 -F qcow2 -b /cache/noble-server-cloudimg-amd64.img /vm/disk.qcow2 18G
  cloud-localds /vm/seed.img /seed/user-data /seed/meta-data
fi
socat TCP-LISTEN:9000,bind=0.0.0.0,reuseaddr,fork TCP:s3:9000 &
# TCG emulates every guest instruction. Run below other containers (such as the test
# database) and power off after VM_LIFETIME, so an interrupted run can't keep the host busy.
# `docker compose start` boots the same disk again.
exec nice -n 10 timeout --signal=TERM "${VM_LIFETIME:-4h}"   qemu-system-x86_64 -machine accel=tcg -cpu max -smp "${VM_SMP:-2}" -m 2048 \
  -nographic -no-reboot -drive file=/vm/disk.qcow2,if=virtio,format=qcow2 \
  -drive file=/vm/seed.img,format=raw,if=virtio \
  -netdev user,id=net,hostfwd=tcp:0.0.0.0:2222-:22,hostfwd=tcp:0.0.0.0:443-:443,hostfwd=tcp:0.0.0.0:80-:80 \
  -device virtio-net-pci,netdev=net
