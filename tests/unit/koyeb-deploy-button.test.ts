import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JWT_SECRET_MIN_LENGTH } from "@/lib/config/auth-env";

// The Koyeb deploy button carries the whole service definition in its URL, environment
// variables included, and that URL lives in a public README. Koyeb cannot generate a
// secret, so the button has to prefill one — and a prefilled secret that CLEARS the
// minimum is a working secret everyone can read: the app boots, signs tokens with it and
// says nothing (#943). Under the minimum, the boot check that already exists stops the
// deploy and names the reason, which is the only safe thing a published placeholder can do.

const README = readFileSync("README.md", "utf8");

function koyebEnv(): Map<string, string> {
  const line = README.split("\n").find((l) => l.includes("app.koyeb.com/deploy"));
  if (line === undefined) throw new Error("the Koyeb deploy button is no longer in README.md");
  const env = new Map<string, string>();
  for (const [, key, value] of line.matchAll(/env%5B([A-Z_]+)%5D=([^&)\s]+)/g)) {
    env.set(key, decodeURIComponent(value));
  }
  return env;
}

describe("the Koyeb deploy button", () => {
  test("prefills a JWT_SECRET the server will refuse", () => {
    const secret = koyebEnv().get("JWT_SECRET");
    expect(secret).toBeDefined();
    expect(secret!.length).toBeLessThan(JWT_SECRET_MIN_LENGTH);
  });

  test("prefills no password anyone could sign in with", () => {
    const env = koyebEnv();
    for (const key of ["ADMIN_PASSWORD", "USER_PASSWORD"]) {
      const value = env.get(key);
      expect(value).toBeDefined();
      // Not a password: a sentence telling the operator to replace it. Anything that reads
      // as a credential is one, once it is in a public file.
      expect(value).toMatch(/^set_a_real_/);
    }
  });

  test("still carries the settings the button exists to set", () => {
    const env = koyebEnv();
    expect(env.get("STORAGE_PROVIDER")).toBe("local");
    expect(env.get("ADMIN_EMAIL")).toBe("admin@libredb.org");
  });
});
