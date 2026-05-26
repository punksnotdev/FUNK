# Provisioning a FUNK Tenant

This is the playbook for going from "fresh Ubuntu VPS" to "FUNK control + media planes running on two machines via Coolify." It's the typical path a consumer follows for a self-host MVP.

Generalized from a prior platform's deploy playbook for any FUNK tenant.

> **Direction (2026-05-26):** Some steps below (step 7's `with-libretime` profile, step 8's invitation-token bootstrap, step 9's LibreTime backup line) reflect the legacy implementation and are being revised per [ADR-001](adr/ADR-001-machine-facing-funk.md) and [ADR-002](adr/ADR-002-liquidsoap-radio-api.md). The target shape: drop the `with-libretime` profile, replace the invitation bootstrap with a single service-credential mint, and remove the LibreTime backup target. Treat this doc as transitional until the code catches up.

---

## Inventory

| Role             | Hostname suggestion | Specs (min)                       | Public ports |
| ---------------- | ------------------- | --------------------------------- | ------------ |
| Control plane    | `funk-control-1`    | 2 vCPU, 4 GB RAM, 40 GB SSD       | 443          |
| Media plane      | `funk-media-1`      | 2 vCPU, 4 GB RAM, 80 GB SSD       | 443          |

Optional for staging mirrors: `funk-control-stage`, `funk-media-stage` (same shape, smaller specs OK).

OS: Ubuntu 22.04 or 24.04 LTS.

---

## Step 1 — Cloud + Networking

1. Provision both servers with SSH keys (no password auth).
2. Create a private network (VPC) and attach both. Internal traffic between control and media goes over this; nothing else needs to.
3. Set up DNS A records pointing the public hostnames at the right machine:
   - `auth.<tenant>.example` → control
   - `storage.<tenant>.example` → control
   - `stream.<tenant>.example` → media
4. If using a CDN in front of `stream.*`, point its origin at media's public IP.

---

## Step 2 — Per-machine hardening (run on both)

```bash
sudo apt update && sudo apt upgrade -y
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# unattended security updates
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Create a non-root admin user (with sudo) for day-to-day ops.

---

## Step 3 — Tailscale (optional but recommended)

For private admin access without exposing SSH publicly:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

Then close port 22 in your firewall and access via Tailscale instead.

---

## Step 4 — Docker (both machines)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in
docker run --rm hello-world
```

---

## Step 5 — Coolify (control machine only)

Coolify lives on the control machine and deploys both planes:

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

After install:

1. Open `http://<control-public-ip>:8000`, create the first admin account.
2. Settings → Servers → add the media machine (paste its Tailscale or private-network IP + the SSH key Coolify generates).
3. Sources → connect this repo (GitHub/GitLab/Gitea, or import via raw compose).

---

## Step 6 — Deploy the control plane

In Coolify:

1. **New Resource → Docker Compose Empty**, target server: `funk-control-1`.
2. Paste contents of `infra/compose/compose.control.yml`. (Do **not** include the dev override.)
3. In **Environment Variables**, paste your `infra/env/control.prod.env` (or the staging version). All `__SET_VIA_SECRETS__` placeholders must be replaced with real values.
4. Set the `with-edge` profile so Caddy starts and terminates TLS for `AUTH_PUBLIC_HOSTNAME` + `STORAGE_PUBLIC_HOSTNAME`.
   - Or skip Caddy if Coolify's built-in Traefik proxy is fronting things — in that case wire the `auth` and `storage` services to Coolify's domains.
5. Deploy. Wait for `postgres`, `minio`, `auth`, `storage` to all report healthy.
6. Verify:
   ```bash
   curl -sSf https://auth.<tenant>.example/health
   curl -sSf https://storage.<tenant>.example/health
   ```

---

## Step 7 — Deploy the media plane

1. **New Resource → Docker Compose Empty**, target server: `funk-media-1`.
2. Paste contents of `infra/compose/compose.media.yml`.
3. Paste `infra/env/media.prod.env` (or staging).
4. Set both profiles: `with-edge` (Caddy) and `with-libretime`.
5. Deploy. Wait for `icecast`, `libretime`, `hls`, `nginx`, `caddy` to be healthy.
6. Verify HLS is being produced:
   ```bash
   curl -sSf https://stream.<tenant>.example/hls/master.m3u8 | head -10
   ```

---

## Step 8 — Bootstrap the first admin invitation

Once `auth` is healthy, mint the first contributor invitation:

```bash
ADMIN_TOKEN=...    # the ADMIN_BOOTSTRAP_TOKEN you set in env
curl -sS -X POST https://auth.<tenant>.example/invitations \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"role":"admin","note":"first admin"}'
```

The response contains a `token` — share it with the first admin user. They claim it via `POST /sessions`.

After at least one admin claims a session, you can rotate `ADMIN_BOOTSTRAP_TOKEN` (and redeploy) so the bootstrap token is no longer valid.

---

## Step 9 — Backups (before going live)

1. Schedule nightly `pg_dump` of the control plane Postgres → off-server destination (S3, B2, restic to a remote).
2. Mirror the MinIO bucket to a second S3-compatible destination.
3. The media plane is **stateless** between deploys — HLS data is regenerated from Icecast. Back up only the LibreTime database (when in use) and Caddy's `/data` directory (for cert continuity).

A starter script lives at `scripts/backup-postgres.sh` (TODO: port from prior implementation).

---

## Day-2 ops checklist

- [ ] Rotate `ADMIN_BOOTSTRAP_TOKEN` and redeploy
- [ ] Disable public SSH (Tailscale only)
- [ ] Set up Prometheus/Grafana scraping (deferred — see roadmap)
- [ ] Confirm CDN in front of media plane
- [ ] Document the on-call runbook
