/**
 * Unit tests for the DigitalOcean 1-Click Droplet build (deploy/digitalocean/droplet).
 *
 * Nothing here reaches DigitalOcean. These assert the invariants whose violation is
 * invisible in a green Packer build and only surfaces on a buyer's Droplet: an
 * environment file written without the flag that makes plain-HTTP login work, a
 * secret that stopped being generated per instance, or an env file that stopped
 * being written with a restrictive mode.
 *
 * The AWS sibling is guarded the same way in aws-ami-descriptor.test.ts. The two
 * images ship the same shape - a bare VM reached over plain HTTP at :3000 with no
 * name of its own - so they need the same invariants held.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const DROPLET = path.join(__dirname, "../../deploy/digitalocean/droplet");
const read = (relative: string): string => fs.readFileSync(path.join(DROPLET, relative), "utf8");

const firstBoot = read("files/var/lib/cloud/scripts/per-instance/99-libredb-first-boot.sh");

/**
 * The body of the heredoc that becomes /etc/libredb-studio.env, and nothing else.
 * Asserting against the whole script would match the explanatory comments above it,
 * which name the same variables: a test that passes because of a comment is worse
 * than no test.
 */
const OPEN = "cat > /etc/libredb-studio.env <<EOF\n";
const envFile = (() => {
  const start = firstBoot.indexOf(OPEN);
  if (start < 0) throw new Error("the first-boot script no longer writes /etc/libredb-studio.env with a heredoc");
  const body = firstBoot.slice(start + OPEN.length);
  const end = body.indexOf("\nEOF");
  if (end < 0) throw new Error("the heredoc that writes /etc/libredb-studio.env is not terminated");
  return body.slice(0, end);
})();

describe("DigitalOcean Droplet first boot", () => {
  test("credentials are generated per instance", () => {
    expect(firstBoot).toMatch(/JWT_SECRET=\$\(openssl rand -base64 48\)/);
    expect(firstBoot).toMatch(/ADMIN_PASSWORD=\$\(openssl rand -hex 12\)/);
    expect(firstBoot).toMatch(/USER_PASSWORD=\$\(openssl rand -hex 12\)/);
  });

  test("the environment file carries AUTH_COOKIE_SECURE=false", () => {
    // The Droplet is reached at http://<ip>:3000, which is plain HTTP on a host
    // that is not loopback. Without this line the auth cookie is marked Secure,
    // the browser discards it, and login loops back to the sign-in page while
    // /api/db/health keeps answering healthy. The AWS AMI writes the same line
    // for the same reason; src/lib/auth.ts holds the rule that decides it.
    expect(envFile.split("\n")).toContain("AUTH_COOKIE_SECURE=false");
  });

  test("the environment file is written with a restrictive mode", () => {
    expect(firstBoot).toMatch(/chmod 600 \/etc\/libredb-studio\.env/);
  });

  test("no comment leaks into the environment file", () => {
    // The heredoc is copied verbatim into /etc/libredb-studio.env, which systemd
    // reads as KEY=value. A '#' line inside it would be written to the file.
    for (const line of envFile.split("\n").filter((l) => l.trim() !== "")) {
      expect(line).toMatch(/^[A-Z_][A-Z0-9_]*=/);
    }
  });
});
