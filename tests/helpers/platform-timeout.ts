/**
 * The Windows factor a test applies to a bound it sets for itself.
 *
 * The runner already raises bun's per-test default on Windows
 * (`WINDOWS_PER_TEST_TIMEOUT_MS` in tests/runner/options.ts), but a test that passes
 * its OWN timeout to `test()` overrides that default, so the heavy ones opt back in
 * here instead of carrying a single number sized for the slowest platform.
 *
 * The gap is not small. `tests/unit/lib/agent/run-store-history.test.ts` writes 10 000
 * history chunk files and then deletes them: 2.1s for the whole file on linux-x64,
 * 141.7s on windows-latest, with the 10 000-entry test alone at 128.6s against the
 * 120 000ms bound it had set for itself (CI run 35242402285). A flat raise would hide
 * a real regression on the leg that runs in 2.1s, which is the leg every contributor
 * and the coverage gate use, so the raise is Windows only.
 *
 * The factor is deliberately modest: the runner's per-file budget
 * (`DEFAULT_FILE_TIMEOUT_MS`, 300 000ms) still has to fire on a file that genuinely
 * hangs, so a scaled per-test bound has to stay under it. tests/unit/platform-timeout.test.ts
 * holds that line for the bounds actually in use.
 */
export const WINDOWS_SLOW_FACTOR = 2;

/**
 * The bound `ms` becomes on the platform being run on: unchanged everywhere but Windows.
 *
 * The platform is a parameter rather than a read of `process.platform` inside the branch,
 * so the Windows case is driven by a test on a machine that is not Windows.
 */
export function platformTimeoutMs(ms: number, platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? ms * WINDOWS_SLOW_FACTOR : ms;
}
