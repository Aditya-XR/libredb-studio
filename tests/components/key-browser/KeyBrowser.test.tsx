import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, afterEach } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";

import { KeyBrowser } from "@/components/key-browser";
import { SCAN_ALL_MAX_KEYS } from "@/components/key-browser/use-key-scan";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The panel: a sampled walk drawn as the tree its names imply.
 *
 * IT LOADS ITS FIRST PAGE ITSELF, so every test here waits for that page before asserting — and the
 * first one asserts the WAIT, because a panel that rendered nothing until somebody found a button
 * would pass every other test in this file while looking broken to everyone.
 */

const CONNECTION: DatabaseConnection = {
  id: "redis-1",
  name: "Local Redis",
  type: "redis",
  host: "127.0.0.1",
  port: 6380,
  createdAt: new Date(0),
};

const CAPABILITY = { defaultCount: 500, maxCount: 1000 };

function page(keys: string[], cursor: string, total = 31): MockFetchResponse {
  return { json: { keys, cursor, total } };
}

/** The cursor the request carried. The helper hands a real `Request`, so its body is read once. */
async function cursorOf(req: Request): Promise<string> {
  const body = (await req.json().catch(() => ({}))) as { cursor?: string };
  return body.cursor ?? "0";
}

function renderBrowser(capability = CAPABILITY) {
  return render(<KeyBrowser connection={CONNECTION} capability={capability} />);
}

/** The progress line's text, which is the one number the panel promises to keep honest. */
function progress(): string {
  return screen.getByTestId("key-browser-progress").textContent ?? "";
}

/** The rows currently drawn, in order, as `label@depth`. */
function rows(): string[] {
  return screen.queryAllByRole("treeitem").map((row) => {
    const label = row.querySelector("span.truncate")?.textContent ?? "";
    const depth = (Number.parseInt(row.style.paddingLeft, 10) - 8) / 12;
    return `${label}@${depth}`;
  });
}

describe("KeyBrowser", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("loads its first page without being asked", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    renderBrowser();

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(1);
    });
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });
    // A leaf under one folder is indented by the project's own `8 + depth * 12`, so a key lines up
    // with a table two levels down elsewhere in the product. It is drawn only once its folder is
    // opened, which is the state every level below the top starts in.
    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0", "app:env@1"]);
    expect(progress()).toBe("Scanned 1/31");
  });

  test("shows a spinner rather than an empty-state claim while the first page is in flight", async () => {
    // The gate is built first and its opener assigned inside the executor: an assignment inside a
    // callback is one TypeScript cannot see, so `release` would narrow to `null` and stop compiling.
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await gate;
        return page(["a"], "0");
      },
    });
    const { container } = renderBrowser();

    // "This database holds no keys" is a CLAIM ABOUT THE SERVER, and making it before the server has
    // answered is the one thing an empty state must not do.
    expect(screen.getByTestId("key-browser-empty")).toBeDefined();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("This database holds no keys the walk has seen")).toBeNull();

    release();
    await waitFor(() => {
      expect(screen.queryByTestId("key-browser-empty")).toBeNull();
    });
  });

  test("says the database holds nothing once a spent walk found nothing", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page([], "0", 0) });
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("This database holds no keys the walk has seen")).toBeDefined();
    });
    expect(progress()).toBe("Scanned 0/0");
  });

  test("opens and closes a folder without asking the server for anything", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl", "app:env"], "0") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });
    const before = fetchMock.mock.calls.length;

    // The keys are already here, so a twisty is a local rearrangement — which is the whole reason a
    // sampled walk can answer a click instantly.
    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0", "cache:*@1", "app:env@1"]);
    expect(fetchMock.mock.calls.length).toBe(before);

    // Each level opens on its own: opening `app` did not open `cache`, and nothing re-fetched.
    fireEvent.click(screen.getByText("cache:*"));
    expect(rows()).toEqual(["app:*@0", "cache:*@1", "app:cache:ttl@2", "app:env@1"]);
    expect(fetchMock.mock.calls.length).toBe(before);

    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0"]);
  });

  test("opens a folder from the keyboard as well as the pointer", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });

    fireEvent.keyDown(screen.getByText("app:*"), { key: "Enter" });
    expect(rows()).toEqual(["app:*@0", "app:env@1"]);

    fireEvent.keyDown(screen.getByText("app:*"), { key: " " });
    expect(rows()).toEqual(["app:*@0"]);

    // Any other key is not a toggle, so the row stays as it is rather than folding on a stray press.
    fireEvent.keyDown(screen.getByText("app:*"), { key: "Tab" });
    expect(rows()).toEqual(["app:*@0"]);
  });

  test("filters the keys it holds and opens the folders that lead to a match", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl", "user:1001:name", "healthcheck"], "0") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0", "user:*@0", "healthcheck@0"]);
    });

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "1001" } });

    // The match is two levels down. Left collapsed it would look like no match at all, which is the
    // one answer a filter must never give.
    expect(rows()).toEqual(["user:*@0", "1001:*@1", "user:1001:name@2"]);

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "nothing-here" } });
    expect(screen.getByText("No key matches the filter")).toBeDefined();
  });

  test("restarts the walk when the pattern changes", async () => {
    const seen: string[] = [];
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const body = (await req.json()) as { pattern?: string };
        seen.push(body.pattern ?? "");
        return body.pattern === undefined ? page(["app:env"], "0") : page(["app:cache:ttl"], "0");
      },
    });
    renderBrowser();
    await waitFor(() => {
      expect(progress()).toBe("Scanned 1/31");
    });

    fireEvent.change(screen.getByLabelText("Match pattern"), { target: { value: "app:cache:*" } });

    // A new pattern is a new walk: the old keys are not answers to it, so the tree is rebuilt from
    // the new walk's own first page rather than appended to. Opening the folder is what proves the
    // rebuild — `env` came from the abandoned walk and must be gone.
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });
    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0", "cache:*@1"]);
    expect(seen).toEqual(["", "app:cache:*"]);
  });

  test("shows the route's own sentence when a page fails, and no tree", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": { status: 500, json: { error: "NOPERM no scan for you" } } });
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByTestId("key-browser-error").textContent).toContain("NOPERM no scan for you");
    });
    // No empty state beside the failure: the two are different facts, and drawing both would claim
    // the database holds nothing about a read that never happened.
    expect(screen.queryByTestId("key-browser-empty")).toBeNull();
  });

  test("offers Stop while Scan all runs and reports what ended the walk", async () => {
    /*
     * A batch as wide as the cap, so ONE page reaches it. The cap is counted in KEYS, and a
     * capability declaring a ten-thousand-key batch is what makes that reachable in one round trip
     * rather than twenty. This test is about the panel rendering the outcome; the walk itself is
     * `use-key-scan`'s own suite, at 500 a page.
     */
    const wide = { defaultCount: SCAN_ALL_MAX_KEYS, maxCount: SCAN_ALL_MAX_KEYS };
    const keys = Array.from({ length: SCAN_ALL_MAX_KEYS }, (_, index) => `bulk:${index}`);
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        call += 1;
        // The FIRST page answers at once, so the panel settles with a walk still open; the second is
        // held so `Scan all` can be observed mid-flight.
        if (call > 1) await gate;
        return page(keys, `${call}00000`);
      },
    });
    renderBrowser(wide);
    await waitFor(() => {
      // Raw digits: the pair is a ratio to be read at a glance rather than a figure whose magnitude
      // is being checked, so thousands separators would be noise in the one line that carries the
      // walk's progress.
      expect(progress()).toBe("Scanned 10000/31");
    });

    fireEvent.click(screen.getByText("Scan all"));
    // The same control becomes Stop rather than a second Scan all nobody can tell apart from the
    // first.
    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeDefined();
    });

    release();
    await waitFor(() => {
      expect(screen.getByTestId("key-browser-stopped").textContent).toContain("Stopped after 10,000 keys");
    });
    expect(screen.getByText("Scan all")).toBeDefined();
  });

  test("Scan more takes one more page and stops offering itself at the end of the walk", async () => {
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? page(["app:env"], "1") : page(["user:1001:name"], "0");
      },
    });
    renderBrowser();
    await waitFor(() => {
      expect(progress()).toBe("Scanned 1/31");
    });

    fireEvent.click(screen.getByText("Scan more"));
    await waitFor(() => {
      expect(progress()).toBe("Scanned 2/31");
    });
    expect(rows()).toEqual(["app:*@0", "user:*@0"]);

    // A spent cursor is the only end-of-walk signal there is, and a button that stayed enabled would
    // re-walk a key space it has already seen.
    await waitFor(() => {
      expect((screen.getByText("Scan more") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test("Stop ends the loop and leaves the walk resumable", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        call += 1;
        const cursor = await cursorOf(req);
        if (call === 1) return page(["a"], "1");
        // The page `Scan all` is waiting on, held so Stop can land while it is in flight.
        if (call === 2) {
          await gate;
          return page(["b"], "2");
        }
        return page([`c-${cursor}`], "3");
      },
    });
    renderBrowser();
    await waitFor(() => {
      expect(progress()).toBe("Scanned 1/31");
    });

    fireEvent.click(screen.getByText("Scan all"));
    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Stop"));
    release();

    await waitFor(() => {
      expect(screen.getByTestId("key-browser-stopped").textContent).toContain("Stopped.");
    });
    // The page already in flight lands and is counted: it is not a request that can be recalled.
    expect(progress()).toBe("Scanned 2/31");

    // Stop ends the LOOP and not the walk, so the cursor it left is still a position to carry on
    // from — which is what makes a bounded `Scan all` useful rather than a dead end.
    fireEvent.click(screen.getByText("Scan more"));
    await waitFor(() => {
      expect(progress()).toBe("Scanned 3/31");
    });
    // Three keys with no separator are three leaves at the top level, each its own segment.
    expect(rows()).toEqual(["a@0", "b@0", "c-2@0"]);
  });

  /**
   * The prefix-scoped walk, which is the only thing that can answer "is there more under here" about
   * a prefix the global sample missed. Its row is a SIBLING of the children it follows, one level
   * deeper than the folder it belongs to.
   */
  describe("Load more", () => {
    test("offers itself under an open folder and asks about that prefix", async () => {
      const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "9") });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      // Nothing to continue while the folder is closed: the row would be an offer with nothing above
      // it.
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();

      fireEvent.click(screen.getByText("app:*"));
      const more = screen.getByTestId("key-browser-load-more");
      expect(more.textContent).toContain("Click to load more");

      fireEvent.click(more);

      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBe(2);
      });
      const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)) as Record<string, unknown>;
      // The pattern is built from the prefix, and the cursor starts at `"0"` because this row's own
      // walk is what moves it from there.
      expect(body).toMatchObject({ pattern: "app:*", cursor: "0" });
    });

    test("stops offering itself for a prefix whose own walk came back spent", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          return call === 1 ? page(["app:env"], "9") : page(["app:only"], "0");
        },
      });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      fireEvent.click(screen.getByTestId("key-browser-load-more"));
      await waitFor(() => {
        expect(rows()).toContain("app:only@1");
      });
      // Cursor `"0"` is the one thing that PROVES there is nothing more under the prefix, so the row
      // goes rather than staying as an offer that can only come back empty.
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();
    });

    test("stops offering itself everywhere once the database walk is spent", async () => {
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0", 1) });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      // A spent cursor at the DATABASE level means the sample IS the key space, so every prefix in it
      // is complete: a "there may be more" row would be a claim the walk already disproved.
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();
    });

    test("keeps the tree when a scoped page fails, and says so", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          return call === 1 ? page(["app:env"], "9", 31) : { status: 500, json: { error: "NOPERM no scan" } };
        },
      });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));
      fireEvent.click(screen.getByTestId("key-browser-load-more"));

      await waitFor(() => {
        expect(screen.getByTestId("key-browser-error").textContent).toContain("NOPERM no scan");
      });
      // The rows the server really gave are still answers, so a page that could not be taken does not
      // take them away.
      expect(rows()).toEqual(["app:*@0", "app:env@1"]);
      expect(screen.queryByTestId("key-browser-empty")).toBeNull();
    });

    test("does not offer itself while a filter is on", async () => {
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "9") });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));
      expect(screen.getByTestId("key-browser-load-more")).toBeDefined();

      // A filtered view is a view of WHAT IS HELD, and a row that pulled more keys into it would make
      // what a reader sees depend on clicks the filter's term does not explain.
      fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "env" } });
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();
      expect(rows()).toEqual(["app:*@0", "app:env@1"]);

      fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "" } });
      expect(screen.getByTestId("key-browser-load-more")).toBeDefined();
    });

    test("counts a folder's CHILDREN, not the keys under it", async () => {
      // `app` can be opened to two rows and holds three keys, which is the whole point: a reader
      // compares the badge against the list below it, and reading the deeper number as "children" is
      // how a folder comes to look like it is missing rows.
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:a:1", "app:a:2", "app:b"], "0", 3) });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));
      expect(rows()).toEqual(["app:*@0", "a:*@1", "app:b@1"]);

      const appRow = screen
        .queryAllByRole("treeitem")
        .find((row) => row.querySelector("span.truncate")?.textContent === "app:*");
      const badge = appRow?.querySelector("span.ml-auto");
      expect(badge?.textContent).toBe("2");
      // The number that is NOT shown is still reachable, because it answers a different question and
      // hiding it altogether would make the badge look like an error.
      expect(badge?.getAttribute("title")).toContain("3");
      expect(badge?.getAttribute("title")).toContain("scanned keys");
    });
  });
});
