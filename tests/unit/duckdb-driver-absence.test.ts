/**
 * Unit tests for the DuckDB driver-absence seam (issue #840).
 *
 * The `-alpine-slim` image leaves `@duckdb/node-api` out on purpose: the driver
 * is four packages ending in a ~70 MB `libduckdb.so`, which is the single
 * largest removable item in the image. The provider reaches it through
 * `await import("@duckdb/node-api")` inside `openDuckDBClient`, so its absence
 * stays inert until somebody opens a DuckDB connection.
 *
 * What that looked like before this seam, measured in the built image on
 * 2026-09-18 and shown verbatim in the connection dialog:
 *
 *   Failed to load external module @duckdb/node-api-7f7f433da97dfb54: Error:
 *   Cannot find module '@duckdb/node-api-7f7f433da97dfb54' Require stack: -
 *   /app/.next/server/chunks/[externals]_@duckdb_node-api_1972eto._.js - ...
 *
 * Two things are wrong with that and both are asserted below: it does not tell
 * the operator which tag to use, and it prints this deployment's internal file
 * layout into a browser toast.
 *
 * The seam is deliberately narrow. Only a module-resolution failure NAMING THIS
 * PACKAGE becomes the friendly error; every other import failure is re-raised
 * unchanged, because "DuckDB is not installed in this image" is a lie if the
 * real fault was a corrupt binding or a different missing dependency.
 */
import { describe, expect, test } from "bun:test";
import { describeDriverAbsence, loadDuckDBDriver } from "@/lib/db/providers/sql/duckdb/client";
import { ConnectionError } from "@/lib/db/errors";

/** The shape Next's externals shim produces in the built image. */
const TURBOPACK_ABSENCE = new Error(
  "Failed to load external module @duckdb/node-api-7f7f433da97dfb54: Error: Cannot find module " +
    "'@duckdb/node-api-7f7f433da97dfb54'\nRequire stack:\n- /app/.next/server/chunks/[externals]_@duckdb_node-api_1972eto._.js",
);

/** The shape a plain Node resolution failure produces outside the bundler. */
function nodeAbsence(): Error {
  const error = new Error("Cannot find module '@duckdb/node-api' imported from /app/server.js");
  (error as Error & { code: string }).code = "ERR_MODULE_NOT_FOUND";
  return error;
}

describe("describeDriverAbsence", () => {
  test("recognizes the bundled image's external-module failure", () => {
    const described = describeDriverAbsence(TURBOPACK_ABSENCE);

    expect(described).toBeInstanceOf(ConnectionError);
    expect(described?.provider).toBe("duckdb");
  });

  test("recognizes a plain Node module-resolution failure", () => {
    expect(describeDriverAbsence(nodeAbsence())).toBeInstanceOf(ConnectionError);
  });

  test("names the tags that do ship the driver, so the operator can act on it", () => {
    const message = describeDriverAbsence(TURBOPACK_ABSENCE)?.message ?? "";

    expect(message).toContain("alpine-slim");
    expect(message).toContain("@duckdb/node-api");
  });

  test("prints no path from this deployment's own file layout", () => {
    const message = describeDriverAbsence(TURBOPACK_ABSENCE)?.message ?? "";

    // The control is the input: the error it was built from carries both.
    expect(TURBOPACK_ABSENCE.message).toContain("/app/.next/server/chunks/");
    expect(message).not.toContain("/app/");
    expect(message).not.toContain("Require stack");
  });

  test("declines a module-resolution failure for a different package", () => {
    // "DuckDB is not in this image" would be a false statement here, and it
    // would send the operator to change tags over an unrelated fault.
    const other = new Error("Cannot find module 'detect-libc'");

    expect(describeDriverAbsence(other)).toBeNull();
  });

  test("declines an import failure that is not about resolution", () => {
    const corrupt = new Error("libduckdb.so: invalid ELF header");

    expect(describeDriverAbsence(corrupt)).toBeNull();
  });

  test("declines a thrown non-Error without assuming it has a message", () => {
    expect(describeDriverAbsence("@duckdb/node-api exploded")).toBeNull();
  });
});

describe("loadDuckDBDriver", () => {
  test("hands back whatever the loader resolved", async () => {
    const stub = { DuckDBInstance: { create: () => {} } } as unknown as typeof import("@duckdb/node-api");

    expect(await loadDuckDBDriver(async () => stub)).toBe(stub);
  });

  test("raises the friendly error when the package is absent", async () => {
    const attempt = loadDuckDBDriver(async () => {
      throw TURBOPACK_ABSENCE;
    });

    await expect(attempt).rejects.toBeInstanceOf(ConnectionError);
  });

  test("re-raises every other import failure unchanged", async () => {
    const corrupt = new Error("libduckdb.so: invalid ELF header");
    const attempt = loadDuckDBDriver(async () => {
      throw corrupt;
    });

    // Identity, not shape: a wrapped copy would lose the stack that says which
    // file failed to load, which is the only useful thing about this failure.
    await expect(attempt).rejects.toBe(corrupt);
  });
});
