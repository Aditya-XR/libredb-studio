/**
 * src/proxy.ts with the OIDC bearer channel (src/lib/oidc-bearer.ts). On an API path that needs a session a Bearer
 * header decides alone while the channel is on; a page never takes one; and with the channel off the header is ignored,
 * so a reverse proxy that forwards `Authorization: Basic` (CapRover httpAuth) or a bearer of its own changes nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { proxy } from "@/proxy";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetBearerKeys } from "@/lib/oidc-bearer";
import {
  bearerClaims,
  nowSeconds,
  provider,
  restoreBearerEnv,
  signBearer,
  stubIdentityProvider,
  useBearerEnv,
} from "../helpers/oidc-bearer-provider";

const JWT_SECRET = new TextEncoder().encode("test-jwt-secret-for-unit-tests-32ch");

async function cookieToken(username = "cookie@example.test") {
  return await new SignJWT({ role: "user", username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

function request(pathname: string, init: { authorization?: string; cookie?: string; owner?: string } = {}) {
  const headers = new Headers();
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", `auth-token=${init.cookie}`);
  if (init.owner) headers.set("x-libredb-workspace-owner", encodeURIComponent(init.owner));
  return new NextRequest(`http://localhost:3000${pathname}`, { headers });
}

const passedThrough = (response: Response) => response.status === 200 && response.headers.get("location") === null;

const fetchSpy = stubIdentityProvider();
afterAll(() => fetchSpy.mockRestore());

beforeEach(() => {
  useBearerEnv();
  resetBearerKeys();
  clearRateLimitState();
});

afterEach(restoreBearerEnv);

describe("proxy with the bearer channel on", () => {
  test("a valid access token reaches an API route without a cookie", async () => {
    const response = await proxy(request("/api/db/query", { authorization: `Bearer ${await signBearer()}` }));

    expect(passedThrough(response)).toBe(true);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a refused token answers 401 with the bearer challenge, even next to a valid cookie, and is audited", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const expired = await signBearer(bearerClaims({ exp: nowSeconds() - 120 }));
      const response = await proxy(
        request("/api/db/query", { authorization: `Bearer ${expired}`, cookie: await cookieToken() }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({ error: "Invalid access token", code: "AUTH_REQUIRED" });
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('"reason":"bearer_token_invalid"'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a broken audit sink still answers the 401 rather than failing the request", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await proxy(request("/api/db/query", { authorization: "Bearer not-a-jwt" }));

      expect(response.status).toBe(401);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("Failed to record a bearer refusal audit event");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("an account without a role is refused with its own audit reason", async () => {
    process.env.OIDC_USER_ROLES = "user";
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const guest = await signBearer(bearerClaims({ realm_access: { roles: ["guest"] } }));
      const response = await proxy(request("/api/db/query", { authorization: `Bearer ${guest}` }));

      expect(response.status).toBe(401);
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('"reason":"bearer_no_role"'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a provider that cannot be reached answers 503, not 401, and writes no permission_denied line", async () => {
    provider.down = true;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await proxy(request("/api/db/query", { authorization: `Bearer ${await signBearer()}` }));

      expect(response.status).toBe(503);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.json()).toEqual({
        error: "The identity provider could not be reached to verify the access token. Try again.",
        code: "IDENTITY_PROVIDER_UNAVAILABLE",
      });
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes("permission_denied"))).toBe(false);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("a page never takes a bearer: without a cookie it goes to sign in", async () => {
    const response = await proxy(request("/", { authorization: `Bearer ${await signBearer()}` }));

    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  test("a page with a valid cookie loads whatever the bearer says", async () => {
    const response = await proxy(request("/", { authorization: "Bearer not-a-jwt", cookie: await cookieToken() }));

    expect(passedThrough(response)).toBe(true);
  });

  test("a Basic header is ignored, so the cookie decides", async () => {
    const response = await proxy(
      request("/api/db/query", { authorization: "Basic dXNlcjpwYXNz", cookie: await cookieToken() }),
    );

    expect(passedThrough(response)).toBe(true);
  });

  test("the public sign-in routes never read the header, so an expired bearer can sign in again", async () => {
    const expired = await signBearer(bearerClaims({ exp: nowSeconds() - 120 }));
    const response = await proxy(request("/api/auth/login", { authorization: `Bearer ${expired}` }));

    expect(passedThrough(response)).toBe(true);
  });

  test("the workspace owner header is checked against the access token's user", async () => {
    const token = await signBearer();
    const mine = await proxy(request("/api/db/query", { authorization: `Bearer ${token}`, owner: "ada@example.test" }));
    const theirs = await proxy(
      request("/api/db/query", { authorization: `Bearer ${token}`, owner: "bob@example.test" }),
    );

    expect(passedThrough(mine)).toBe(true);
    expect(theirs.status).toBe(409);
  });
});

describe("proxy with the bearer channel off", () => {
  beforeEach(() => {
    delete process.env.OIDC_BEARER_AUDIENCE;
  });

  test("a bearer alone is no session, answered as before", async () => {
    const response = await proxy(request("/api/db/query", { authorization: `Bearer ${await signBearer()}` }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(provider.discoveryCalls).toBe(0);
  });

  test("a cookie request carrying any Authorization header works as before", async () => {
    const cookie = await cookieToken();
    const responses = await Promise.all(
      ["Basic dXNlcjpwYXNz", "Bearer a-token-some-proxy-forwarded"].map((authorization) =>
        proxy(request("/api/db/query", { authorization, cookie })),
      ),
    );
    expect(responses.map(passedThrough)).toEqual([true, true]);
  });
});
