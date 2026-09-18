import { describe, expect, test } from "bun:test";
import { GET as rootHealth } from "@/app/health/route";
import { GET as apiHealth } from "@/app/api/health/route";
import { GET as dbHealth } from "@/app/api/db/health/route";

// Three paths, one answer (#909). An operator points their platform's health field at
// whichever path its form defaults to, and until these existed the two most-guessed ones
// did not answer at all — they redirected to the login screen, which a check that follows
// redirects reads as 200. The measurement is in the issue; `tests/api/proxy.test.ts` holds
// the half this repository can assert, that none of the three is answerable by a redirect.

describe("the liveness routes", () => {
  test("all three answer the same thing", async () => {
    const bodies = await Promise.all([rootHealth(), apiHealth(), dbHealth()].map((r) => r.json()));

    for (const body of bodies) {
      expect(body.status).toBe("healthy");
      expect(body.service).toBe("libredb-studio");
      expect(typeof body.timestamp).toBe("string");
    }
    // Same shape, so a check written against one reads the same from the others.
    expect(Object.keys(bodies[0]).sort()).toEqual(Object.keys(bodies[1]).sort());
    expect(Object.keys(bodies[1]).sort()).toEqual(Object.keys(bodies[2]).sort());
  });

  test("each answers 200 without a session or a database", async () => {
    for (const route of [rootHealth, apiHealth, dbHealth]) {
      expect(route().status).toBe(200);
    }
  });
});
