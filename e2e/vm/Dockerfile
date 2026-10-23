# SPDX-License-Identifier: AGPL-3.0-only
# Test host only. The guests boot an Ubuntu cloud image with their own kernels.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    qemu-system-x86 qemu-utils cloud-image-utils curl ca-certificates openssh-client socat \
 && rm -rf /var/lib/apt/lists/*
COPY boot.sh /boot.sh
ENTRYPOINT ["sh", "/boot.sh"]
