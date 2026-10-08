/**
 * Databend Cloud's hosts (design 6.1, section 4.4 of the provider doc).
 *
 * The gateway answers on `<tenant>.gw.<region>.default.databend.com`, under `databend.cn` in the regions in China, and
 * on an older form that names the warehouse in the host, `<tenant>--<warehouse>.gw.<region>.default.databend.com`,
 * which reaches that warehouse with no warehouse header (measured on the test tenant, 2026-10-08).
 *
 * BendSQL and databend-jdbc count a host ending in `.databend.com`, `.databend.cn` or `.tidbcloud.com` as Databend
 * Cloud's when they choose their presign mode for uploads (`check_presign` in `core/src/client.rs`, `initializePresign`
 * in `DatabendSessionHandle.java`), not for billing, and Databend's Cloud guides name the service TiDB Cloud Lake in
 * their data-integration pages. Studio asks whether a request can resume a billed warehouse, and takes the same three
 * domains: declaring the capability stops the background checks, so a host under `.tidbcloud.com` that does not serve
 * Databend loses its pulse and its fleet check, and its monitoring page shows the billed-compute note; nothing else
 * changes. Databend's docs show the older host form under the first two domains only, so only they are read for a
 * warehouse.
 *
 * Pure, with no import: the connection dialog reads it in the browser when a DSN is pasted, and the provider reads it
 * for its capabilities and for the warehouse its sentences name.
 */

/** The domains Databend Cloud's own gateway answers under, and the only ones the older host form is shown under. */
const DATABEND_DOMAINS: readonly string[] = [".databend.com", ".databend.cn"];

/** Every domain BendSQL and databend-jdbc count as Databend Cloud's. */
const CLOUD_DOMAINS: readonly string[] = [...DATABEND_DOMAINS, ".tidbcloud.com"];

/** The gateway's own label, the second of an older host. */
const GATEWAY_LABEL = "gw";

/** What separates the tenant from the warehouse in the first label of an older host. */
const WAREHOUSE_SEPARATOR = "--";

/** A warehouse as a host label can name it: letters, digits and hyphens, which Databend Cloud's names are made of. */
const HOST_WAREHOUSE = /^[A-Za-z0-9-]{1,63}$/;

/** Whether `host` ends in one of `domains`, in any case and with or without the trailing dot of a full name. */
function underDomain(host: string, domains: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => name.endsWith(domain));
}

/** Whether `host` is Databend Cloud's, so a request to it can resume a billed warehouse. */
export function isDatabendCloudHost(host: string): boolean {
  return underDomain(host, CLOUD_DOMAINS);
}

/**
 * The warehouse an older Databend Cloud host names, `<tenant>--<warehouse>.gw...`, as it is written in the host, or
 * undefined for every other host.
 */
export function databendCloudHostWarehouse(host: string): string | undefined {
  if (!underDomain(host, DATABEND_DOMAINS)) return undefined;
  // A host under one of those domains ends in two labels of its domain, so it has a second label.
  const [first, second] = host.split(".");
  if (second.toLowerCase() !== GATEWAY_LABEL) return undefined;
  const separator = first.indexOf(WAREHOUSE_SEPARATOR);
  if (separator < 1) return undefined;
  const warehouse = first.slice(separator + WAREHOUSE_SEPARATOR.length);
  return HOST_WAREHOUSE.test(warehouse) ? warehouse : undefined;
}
