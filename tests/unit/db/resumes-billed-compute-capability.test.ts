import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `resumesBilledCompute` across every shipped provider.
 *
 * The capability withholds the connection pulse and the admin fleet health check from a
 * connection, and labels the monitoring auto-refresh toggle with the billing sentence. Declared
 * by an engine whose suspended compute a request resumes and bills (a Databend Cloud warehouse),
 * it keeps Studio from holding that compute awake. Declared anywhere else it would silently drop
 * the health of a connection that costs nothing to check, so this census holds every shipped
 * provider to the flag's absence until an engine that bills a resume declares it.
 *
 * Nothing here connects: `createDatabaseProvider` builds each provider over
 * `CENSUS_CONNECTION`'s unconnected configuration, and `getCapabilities()` is a declaration.
 */
describe("resumesBilledCompute across the shipped providers", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s does not declare it", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(provider.getCapabilities().resumesBilledCompute).toBeUndefined();
  });
});
