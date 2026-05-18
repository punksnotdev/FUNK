#!/usr/bin/env bash
# Idempotent baseline provisioning for a fresh Ubuntu 22.04/24.04 host.
# Run as the non-root admin user (the user must already exist with sudo).
#
# Usage:  bash provision-machine.sh
# Or via SSH:  ssh user@host 'bash -s' < scripts/provision-machine.sh
#
# Companion to docs/PROVISIONING.md.

set -euo pipefail

log() { printf '\n==> %s\n' "$*"; }

log "apt update + upgrade"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

log "common utilities"
sudo apt-get install -y curl ca-certificates ufw unattended-upgrades jq

log "harden sshd (no password auth)"
if ! grep -qE '^PasswordAuthentication no' /etc/ssh/sshd_config; then
  sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sudo systemctl restart ssh
fi

log "unattended security upgrades"
sudo dpkg-reconfigure -fnoninteractive unattended-upgrades || true

log "ufw baseline (allow SSH only — extend per-plane after install)"
if ! sudo ufw status | grep -q "Status: active"; then
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow OpenSSH
  sudo ufw --force enable
fi

log "docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "NOTE: log out and back in for the docker group change to take effect."
fi

log "tailscale (optional — uncomment to install)"
# if ! command -v tailscale >/dev/null 2>&1; then
#   curl -fsSL https://tailscale.com/install.sh | sh
#   sudo tailscale up --ssh
# fi

log "done. next: install Coolify on control machine only:"
echo '    curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash'
