#!/bin/bash
set -euo pipefail
source /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl python3
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
install -d -m 0755 /opt
if ! test -d /opt/proxima-appflowy; then
  cp -R /mnt/c/Users/TLPC/Documents/AppFlowySetup/server-staged /opt/proxima-appflowy
fi
chmod 700 /opt/proxima-appflowy
chmod +x /opt/proxima-appflowy/start.sh
exec /opt/proxima-appflowy/start.sh
