# DigitalOcean Marketplace — LibreDB Studio

Build and submission files for the 1-Click Droplet App (Path B of #72).
Base image: **Ubuntu 24.04 LTS** (`ubuntu-24-04-x64`).

## Layout

```
deploy/digitalocean/
├── README.md                          # this file — build guide + submission checklist
├── manifest.yaml                      # Vendor Portal form reference
├── assets/
│   └── description-long.md            # Marketplace long description
└── droplet/
    ├── template.pkr.hcl               # Packer template (manifest post-processor included)
    ├── scripts/
    │   ├── 01-install.sh              # Docker CE + compose plugin, droplet-agent purge, image pre-pull
    │   └── 02-configure.sh            # UFW, exec bits (MOTD + first-boot!), /app/data, version pinning, application.info
    └── files/
        ├── etc/systemd/system/libredb-studio.service
        ├── etc/update-motd.d/99-libredb-studio
        └── var/lib/cloud/scripts/per-instance/99-libredb-first-boot.sh
```

DO's official `90-cleanup.sh` / `99-img-check.sh` are fetched at build time
from [`digitalocean/marketplace-partners`](https://github.com/digitalocean/marketplace-partners)
— they are not vendored here. Both the workflow and the local build pin the
same reviewed commit (the scripts run as root inside the image build); bump
the pin deliberately, in both places, after reviewing upstream changes.

## Build

**GitHub Actions (recommended):** wait for the Docker publish workflow to finish
for the release, then Actions → "DO Packer Build" → Run workflow → select that
release tag and enter the same bare semver as `version`. The image tag must exist
on `ghcr.io/libredb/libredb-studio`; the input has no default. The snapshot ID
appears in the job summary.
Requires the `DIGITALOCEAN_TOKEN` repo secret (read+write PAT).

The build stays **manual by design**: it consumes DigitalOcean resources, and a
snapshot still needs the Droplet checks below and a Vendor Portal submission.
Every successfully published release adds a **DigitalOcean Marketplace release
checklist** to the `publish-release` job summary, including the released version
and the build, test, submission and listing-verification steps. The reminder is
non-blocking and does not create cloud resources or submit an untested image.
Do not add only a `release: published` trigger: this repo publishes releases with
`GITHUB_TOKEN`, whose release events do not start other workflows.

**Local:**

Set `VERSION` to the released bare semver tag you intend to build before running
these commands; there is no default here either.

```bash
: "${VERSION:?Set VERSION to the released semver tag to build}"
cd deploy/digitalocean/droplet
MP_SHA=b70878804ca27c01d5f5e882d26485defbaba210  # keep in sync with .github/workflows/do-packer-build.yml
curl -fsSLo scripts/90-cleanup.sh   "https://raw.githubusercontent.com/digitalocean/marketplace-partners/${MP_SHA}/scripts/90-cleanup.sh"
curl -fsSLo scripts/99-img-check.sh "https://raw.githubusercontent.com/digitalocean/marketplace-partners/${MP_SHA}/scripts/99-img-check.sh"
export DIGITALOCEAN_TOKEN=dop_v1_...
packer init .
packer validate -var "version=$VERSION" .
packer build -var "version=$VERSION" .
```

## Published version check

`bun run distribution:check` (from the repository root) compares
`package.json.version` with the live listing's `custom_data.version`. It reads the
public Marketplace page, including its escaped Next.js metadata; it does not
treat a local Packer version or a successful snapshot build as publication.
A stale listing reports **DRIFT**; unreadable, missing or ambiguous version
metadata reports **UNKNOWN**, never a silent **SKIP**. As with other remote
catalogs, the report is warn-only, including under `--strict`, and runs weekly in
the Distribution Check workflow. Run it again after DigitalOcean approves an
update and verify the published version matches the submitted snapshot.

## Critical build rules

1. **Never reboot after `90-cleanup.sh`.** Cleanup wipes the cloud-init
   semaphores; a reboot would run the first-boot script on the build droplet
   and bake generated secrets into the snapshot — every customer would get
   the same credentials. The flow is always: cleanup → img-check → snapshot.
2. **The first-boot script must be executable.** cloud-init silently skips
   non-executable files; `02-configure.sh` guarantees the exec bit — do not
   remove that line.
3. **The MOTD file must stay extensionless.** `run-parts --lsbsysinit`
   silently ignores files with a `.sh` suffix.
4. **`environment_vars` is mandatory on every provisioner using `${VERSION}`.**
   Without it, `docker pull` and `sed` silently run with an empty value.
5. **`/opt/digitalocean` must not exist in the snapshot** — `99-img-check.sh`
   fails on it; `01-install.sh` purges the droplet-agent.

## Pre-submission checklist

- [ ] `packer validate` → clean
- [ ] Fresh test Droplet from the snapshot ($6) → MOTD shows up
- [ ] `http://<IP>:3000` loads; `/api/db/health` → `{"status":"healthy",…}`
- [ ] Login works with the credentials from `/etc/libredb-studio.env`
- [ ] `sudo grep AUTH_COOKIE_SECURE /etc/libredb-studio.env` → `false`. The
      Droplet is plain HTTP on a public address, so without it the browser
      discards the auth cookie and login loops while health probes still pass
- [ ] SQLite data survives a Droplet restart (`/app/data`)
- [ ] `ufw status` → active (only 22/tcp LIMIT; port 3000 is published via
      Docker's iptables rules and intentionally absent from the ufw list)
- [ ] `cat /root/.ssh/authorized_keys` → empty/missing (remove your test key!)
- [ ] `bash 99-img-check.sh` on the Droplet → "0 Tests FAILED"
- [ ] A "host key changed" SSH warning on first login is expected — cleanup
      deletes host keys; cloud-init regenerates them

## Submission

1. [Vendor Portal](https://cloud.digitalocean.com/vendorportal) → New App → snapshot ID
2. Marketing assets:
   - Logo 128×128 PNG
   - Screenshots (editor + results grid)
   - Short description (≤75 chars): `Open-source SQL IDE with AI — PostgreSQL, MySQL, MongoDB, Redis & more`
   - Long description: `assets/description-long.md`
3. Follow-up: one-clicks-team@digitalocean.com — there is no official review
   SLA; a polite nudge after a couple of weeks is fine.
4. After approval, add the Marketplace link next to the other one-click
   buttons in the root README.
