# Provisioning a FUNK Tenant

This is the playbook for going from "fresh Ubuntu VPS" to "FUNK control + media planes running on two machines via Coolify." It's the typical path a consumer follows for a self-host MVP.

Generalized from a prior platform's deploy playbook for any FUNK tenant.

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
3. Paste `infra/env/media.prod.env` (or staging). All `__SET_VIA_SECRETS__` placeholders must be replaced — in particular `HARBOR_LIVE_PASSWORD` and `HARBOR_BREAKING_PASSWORD`.
4. Set `AUTH_URL` to the public HTTPS URL of the control plane's auth service (e.g. `https://auth.<tenant>.example`). The radio service uses it to validate consumer credentials.
5. Set the `with-edge` profile so Caddy starts and terminates TLS.
6. Deploy. Wait for `icecast`, `liquidsoap`, `hls`, `nginx`, `radio`, `caddy` to be healthy.
7. Verify HLS is being produced:
   ```bash
   curl -sSf https://stream.<tenant>.example/hls/master.m3u8 | head -10
   ```

---

## Step 8 — Mint the first service credential

Once `auth` is healthy, mint the consumer's service credential:

```bash
ADMIN_TOKEN=...    # the ADMIN_BOOTSTRAP_TOKEN you set in env
curl -sS -X POST https://auth.<tenant>.example/v1/credentials \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"primary consumer"}'
```

The response contains a `token` — store it in the consumer's secret manager and configure the consumer to send it as `Authorization: Bearer <token>` on every FUNK call (storage and radio).

Rotate `ADMIN_BOOTSTRAP_TOKEN` (and redeploy) once the consumer credential is issued, so the bootstrap token is no longer valid.

---

## Step 9 — Backups (before going live)

1. Schedule nightly `pg_dump` of the control plane Postgres → off-server destination (S3, B2, restic to a remote).
2. Mirror the MinIO bucket to a second S3-compatible destination.
3. The media plane is **mostly stateless** between deploys — HLS data is regenerated from Icecast, and the applied schedule re-converges on the next consumer PUT. Back up only Caddy's `/data` directory (for cert continuity) and the `funk_recordings` volume if you don't want to lose unsynced live-session recordings during a redeploy.

A starter script lives at `scripts/backup-postgres.sh` (TODO: port from prior implementation).

---

## Day-2 ops checklist

- [ ] Rotate `ADMIN_BOOTSTRAP_TOKEN` and redeploy
- [ ] Disable public SSH (Tailscale only)
- [ ] Set up Prometheus/Grafana scraping (deferred — see roadmap)
- [ ] Confirm CDN in front of media plane
- [ ] Document the on-call runbook
