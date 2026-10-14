import "../setup-dom";

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ConnectionModal } from "@/components/ConnectionModal";
import { SNOWFLAKE_ERROR_SENTENCES } from "@/lib/db/providers/sql/snowflake/errors";
import type { DatabaseConnection } from "@/lib/types";

import { pemArmour } from "../helpers/pem-armour";

/**
 * The Snowflake connection form with the real dialog, the real form hook and the real field declarations, so a
 * refusal the dialog says before anything is sent is measured as the user meets it: by the requests that did not go.
 */

// As in ConnectionModal-test-answer.test.tsx: without Element.animate motion drives its animations from its own frame
// loop rather than through happy-dom's Web Animations.
const nativeAnimate = Element.prototype.animate;
beforeAll(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
afterAll(() => {
  Element.prototype.animate = nativeAnimate;
});

afterEach(cleanup);

function field(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no #${id} in the dialog`);
  return element as HTMLInputElement;
}

function openSnowflake() {
  const probe = mock(async (_connection: DatabaseConnection) => ({ success: true }));
  const onConnect = mock((_connection: DatabaseConnection) => {});
  render(<ConnectionModal isOpen onClose={() => {}} onConnect={onConnect} onTestConnection={probe} />);
  fireEvent.click(screen.getByRole("button", { name: "Snowflake" }));
  return { probe, onConnect };
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("the Snowflake form's own refusals", () => {
  test("an empty Account is refused in its sentence, and neither Test Connection nor Save sends a request", async () => {
    const { probe, onConnect } = openSnowflake();
    fireEvent.change(field("host"), { target: { value: "" } });
    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    fireEvent.change(field("privateKey"), { target: { value: pemArmour("BEGIN") } });

    await click("Test Connection");
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      "Enter Account: an account identifier such as myorg-myaccount, or its URL. Nothing was sent.",
    );
    await click("Establish Connection");
    expect(probe).toHaveBeenCalledTimes(0);
    expect(onConnect).toHaveBeenCalledTimes(0);
  });

  test("a key pair with no key is refused, and so is a token sign-in with no token, each before any request", async () => {
    const { probe } = openSnowflake();
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    await click("Test Connection");
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      "Paste the private key for key-pair sign-in. Nothing was sent.",
    );

    fireEvent.change(field("authMethod"), { target: { value: "pat" } });
    await click("Test Connection");
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      "Enter the programmatic access token. Nothing was sent.",
    );
    expect(probe).toHaveBeenCalledTimes(0);

    // With the token typed, the connection is tested holding the token and no key.
    fireEvent.change(field("password"), { target: { value: "S-TOKEN" } });
    await click("Test Connection");
    expect(probe).toHaveBeenCalledTimes(1);
    const sent = probe.mock.calls[0][0];
    expect(sent).toMatchObject({ type: "snowflake", host: "myorg-myacct", authMethod: "pat", password: "S-TOKEN" });
    expect(sent).not.toHaveProperty("privateKey");
    expect(sent).not.toHaveProperty("port");
  });
});

/** Every text the dialog holds: its markup and the value of each box, which markup alone may not carry. */
function everythingDrawn(): string {
  const values = Array.from(document.querySelectorAll("input, textarea, select")).map(
    (element) => (element as HTMLInputElement).value,
  );
  return [document.body.innerHTML, ...values].join("\n");
}

describe("a Snowflake text in the dialog keeps nothing of its secrets", () => {
  function pasteText(text: string) {
    fireEvent.click(screen.getByRole("button", { name: "Paste URL" }));
    const box = document.querySelector('input[placeholder^="postgres://"]') as HTMLInputElement;
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Parse" }));
  }

  test("a pasted inline key is refused by name, no field is set, and the key is nowhere in the dialog", () => {
    const probe = mock(async (_connection: DatabaseConnection) => ({ success: true }));
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} onTestConnection={probe} />);
    pasteText(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?user=u-applied&token=T-SENTINEL&private_key_base64=K-SENTINEL",
    );
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      "Studio does not take private_key_base64 from a pasted URL. Paste the key itself into Private key, not inside a URL.",
    );
    const drawn = everythingDrawn();
    expect(drawn).not.toContain("K-SENTINEL");
    expect(drawn).not.toContain("T-SENTINEL");
    expect(drawn).not.toContain("u-applied");
    // The dialog shows Snowflake's form, so the Private key box the sentence names is there, and fills nothing else:
    // Account opens empty rather than holding the previous engine's localhost.
    expect(field("authMethod")).toBeDefined();
    expect(field("privateKey").value).toBe("");
    expect(field("host").value).toBe("");
    expect(field("user").value).toBe("");
    expect(probe).toHaveBeenCalledTimes(0);
  });

  test("a pasted key path is refused on Snowflake's form, which shows the Private key box and nothing of the path", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    pasteText(
      "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?user=u-applied&private_key_file=/home/u/P-SENTINEL.p8",
    );
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      "Studio does not take private_key_file from a pasted URL. Studio reads no file: paste the key's contents into Private key.",
    );
    expect(field("privateKey").value).toBe("");
    expect(field("host").value).toBe("");
    const drawn = everythingDrawn();
    expect(drawn).not.toContain("P-SENTINEL");
    expect(drawn).not.toContain("u-applied");
  });

  test("a jdbc: URL typed into Account is refused before any request, in a sentence holding nothing of it", async () => {
    const { probe } = openSnowflake();
    fireEvent.change(field("host"), {
      target: { value: "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?token=S-SENTINEL" },
    });
    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    fireEvent.change(field("privateKey"), { target: { value: pemArmour("BEGIN") } });
    await click("Test Connection");
    const sentence = screen.getByTestId("connection-test-result").textContent ?? "";
    expect(sentence).toContain(
      "Enter an account identifier such as myorg-myaccount, or its https URL; a jdbc: or snowflake:// URL goes into Paste URL instead. Nothing was sent.",
    );
    expect(sentence).not.toContain("S-SENTINEL");
    expect(probe).toHaveBeenCalledTimes(0);
  });

  test("a pasted JDBC URL with a token fills the form and leaves the paste box empty", async () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    pasteText("jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?user=u&token=S-SENT&warehouse=wh");
    expect(field("host").value).toBe("myorg-myacct.snowflakecomputing.com");
    expect(field("user").value).toBe("u");
    expect(field("warehouse").value).toBe("wh");
    expect((field("authMethod") as unknown as HTMLSelectElement).value).toBe("pat");
    expect(field("password").value).toBe("S-SENT");
    expect(document.getElementById("privateKey")).toBeNull();
    // The form state holds no text at once; the box itself goes when its exit animation ends.
    await waitFor(() => expect(document.querySelector('input[placeholder^="postgres://"]')).toBeNull());
    expect(everythingDrawn()).not.toContain("jdbc:snowflake");
    expect(screen.getByTestId("host-hint").textContent).toBe("Studio connects to myorg-myacct.snowflakecomputing.com.");
  });
});

describe("choosing Snowflake", () => {
  const choose = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

  test("opens Account empty after another engine's host, so Test meets the Account sentence, not a sign-in", async () => {
    const probe = mock(async (_connection: DatabaseConnection) => ({ success: true }));
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} onTestConnection={probe} />);
    expect(field("host").value).toBe("localhost");
    choose("Snowflake");
    expect(field("host").value).toBe("");
    expect(screen.queryByTestId("host-hint")?.textContent ?? "").not.toContain("localhost");

    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    fireEvent.change(field("privateKey"), { target: { value: pemArmour("BEGIN") } });
    await click("Test Connection");
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      "Enter Account: an account identifier such as myorg-myaccount, or its URL. Nothing was sent.",
    );
    expect(probe).toHaveBeenCalledTimes(0);
  });

  test("drops a host typed for another engine, and keeps an account typed for Snowflake when it is chosen again", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    choose("MySQL");
    fireEvent.change(field("host"), { target: { value: "db.example.invalid" } });
    choose("Snowflake");
    expect(field("host").value).toBe("");
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    choose("Snowflake");
    expect(field("host").value).toBe("myorg-myacct");
    // Another engine keeps the host as before.
    choose("PostgreSQL");
    expect(field("host").value).toBe("myorg-myacct");
  });
});

describe("the Snowflake key-pair refusal in the result banner", () => {
  const BODY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".repeat(9);
  const FINGERPRINT = "SHA256:Qm9vZ2xlR29vZ2xlR29vZ2xlR29vZ2xlR29vZ2xlR29vZ2xlJWZG3hSx=";

  test("wraps its long words, so the fingerprint and the statement's key body are read whole at any width", async () => {
    const sentence = SNOWFLAKE_ERROR_SENTENCES.keyPairRefused({
      uuid: null,
      account: "MYORG-MYACCT",
      user: "STUDIO_SVC",
      fingerprint: FINGERPRINT,
    });
    const statement = `ALTER USER ADD KEY PAIR STUDIO_0a1b2c3d PUBLIC_KEY = '${BODY}'`;
    const probe = mock(async (_connection: DatabaseConnection) => ({
      success: false,
      error: sentence,
      fixStatement: statement,
    }));
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} onTestConnection={probe} />);
    fireEvent.click(screen.getByRole("button", { name: "Snowflake" }));
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    fireEvent.change(field("privateKey"), { target: { value: pemArmour("BEGIN") } });
    await click("Test Connection");

    const text = screen.getByTestId("connection-test-message");
    expect(text.textContent).toBe(sentence);
    expect(text.textContent).toContain(FINGERPRINT);
    // The key body is in the copyable statement only, never in the banner's sentence (SF-027).
    expect(text.textContent).not.toContain(BODY.slice(0, 40));
    // happy-dom lays nothing out, so the rule that lets a word longer than the line break is what is read: without
    // it the fingerprint and the key bodies run past the banner and its overflow-hidden ancestor clips them.
    expect(text.className.split(" ")).toContain("break-words");
    expect(text.tagName).toBe("P");
    expect(screen.getByTestId("connection-fix-statement").textContent).toBe(statement);
  });
});

describe("the Snowflake Schema, Database and User boxes", () => {
  test("draw Snowflake's hint alone under Schema, and no placeholder that could pass for a typed value", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Snowflake" }));
    const schemaBox = field("schema").closest("div") as HTMLElement;
    expect(schemaBox.textContent).toContain("The default schema for unqualified names.");
    expect(schemaBox.textContent).not.toContain("SHOW SCHEMAS");
    expect(schemaBox.querySelectorAll("p")).toHaveLength(1);
    for (const id of ["user", "database", "schema"]) expect(field(id).placeholder).toBe("");
  });

  test("leave Trino's Schema box as it was, its sentence and placeholders included", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Trino" }));
    expect((field("schema").closest("div") as HTMLElement).textContent).toContain(
      "Run SHOW SCHEMAS to list the catalog's schemas.",
    );
    expect(field("schema").placeholder).toBe("default");
    expect(field("database").placeholder).toBe("tpch");
    expect(field("user").placeholder).toBe("user");
  });

  test("give BigQuery's credential box an example that fits it, and say what an empty box means beneath it (SF-039)", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "BigQuery" }));
    expect(field("password").placeholder).toBe("key JSON, a ya29… token, or empty");
    expect(screen.getByTestId("password-hint").textContent).toBe(
      "The whole key file's JSON, or a bearer token. Empty uses the server's own credentials, where the deployment enables them.",
    );
  });

  test("leave Databend's User box with the dialog's own example, never the root its warning advises against", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Databend" }));
    expect(field("user").placeholder).toBe("user");
    expect(field("database").placeholder).toBe("default");
  });
});

describe("a new engine or a new account opens without the previous one's credentials (SF-002)", () => {
  const choose = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

  function openDialog() {
    const probe = mock(async (_connection: DatabaseConnection) => ({ success: true }));
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} onTestConnection={probe} />);
    return probe;
  }

  function paste(text: string) {
    fireEvent.click(screen.getByRole("button", { name: "Paste URL" }));
    const box = document.querySelector('input[placeholder^="postgres://"]') as HTMLInputElement;
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Parse" }));
  }

  test("PostgreSQL's user, password and database never reach Snowflake, and the token box opens empty", async () => {
    const probe = openDialog();
    fireEvent.change(field("name"), { target: { value: "kept name" } });
    fireEvent.change(field("user"), { target: { value: "pguser" } });
    fireEvent.change(field("password"), { target: { value: "PG-SENTINEL" } });
    fireEvent.change(field("database"), { target: { value: "pgdb" } });
    choose("Snowflake");
    expect(field("user").value).toBe("");
    expect(field("database").value).toBe("");
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("authMethod"), { target: { value: "pat" } });
    expect(field("password").value).toBe("");
    fireEvent.change(field("user"), { target: { value: "u" } });
    fireEvent.change(field("role"), { target: { value: "R" } });
    fireEvent.change(field("password"), { target: { value: "S-TOKEN" } });
    await click("Test Connection");
    expect(probe).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(probe.mock.calls[0][0]);
    expect(sent).not.toContain("PG-SENTINEL");
    expect(sent).not.toContain("pguser");
    expect(sent).not.toContain("pgdb");
    // The name is not the engine's, so it stays.
    expect(probe.mock.calls[0][0].name).toBe("kept name");
  });

  test("a Snowflake URL pasted over PostgreSQL's fields carries none of them", () => {
    openDialog();
    fireEvent.change(field("user"), { target: { value: "pguser" } });
    fireEvent.change(field("password"), { target: { value: "PG-SENTINEL" } });
    fireEvent.change(field("database"), { target: { value: "pgdb" } });
    paste("jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?user=alice&authenticator=PROGRAMMATIC_ACCESS_TOKEN");
    expect(field("user").value).toBe("alice");
    expect(field("password").value).toBe("");
    expect(field("database").value).toBe("");
    expect(everythingDrawn()).not.toContain("PG-SENTINEL");
  });

  test("a second paste naming another account drops the first account's token, database and schema", async () => {
    const probe = openDialog();
    paste(
      "jdbc:snowflake://acct-a.snowflakecomputing.com/?user=alice&warehouse=WH1&db=DB1&schema=S1&role=R1&authenticator=PROGRAMMATIC_ACCESS_TOKEN&token=TOKEN_A_123",
    );
    expect(field("password").value).toBe("TOKEN_A_123");
    paste("jdbc:snowflake://other-acct.snowflakecomputing.com/?user=bob");
    expect(field("host").value).toBe("other-acct.snowflakecomputing.com");
    expect(field("user").value).toBe("bob");
    expect(field("database").value).toBe("");
    expect(field("schema").value).toBe("");
    // The sign-in method is the first account's choice too, so the form opens on the default key pair.
    expect((field("authMethod") as unknown as HTMLSelectElement).value).toBe("keypair");
    expect(everythingDrawn()).not.toContain("TOKEN_A_123");
    fireEvent.change(field("role"), { target: { value: "R" } });
    fireEvent.change(field("privateKey"), { target: { value: pemArmour("BEGIN") } });
    await click("Test Connection");
    expect(JSON.stringify(probe.mock.calls[0][0])).not.toContain("TOKEN_A_123");
  });

  test("a paste naming the same account keeps what was typed for it", () => {
    openDialog();
    choose("Snowflake");
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("privateKey"), { target: { value: "KEY-TYPED" } });
    paste("snowflake://carol@MYORG-MYACCT/DB3");
    expect(field("user").value).toBe("carol");
    // The key is kept, and drawn as kept rather than as text (SF-014).
    expect(screen.getByTestId("privateKey-stored")).toBeDefined();
  });

  test("a typed key and passphrase survive neither a paste for another account nor a switch to PostgreSQL and back", () => {
    openDialog();
    choose("Snowflake");
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("privateKey"), { target: { value: "KEY-SENTINEL" } });
    fireEvent.change(field("privateKeyPassphrase"), { target: { value: "PASS-SENTINEL" } });
    paste("snowflake://carol@third-acct/DB3");
    expect(field("host").value).toBe("third-acct.snowflakecomputing.com");
    expect(field("privateKey").value).toBe("");
    expect(field("privateKeyPassphrase").value).toBe("");

    fireEvent.change(field("privateKey"), { target: { value: "KEY-SENTINEL" } });
    fireEvent.change(field("privateKeyPassphrase"), { target: { value: "PASS-SENTINEL" } });
    choose("PostgreSQL");
    choose("Snowflake");
    expect(field("privateKey").value).toBe("");
    expect(field("privateKeyPassphrase").value).toBe("");
  });

  test("Snowflake's warehouse and user are not sent to Databend", async () => {
    const probe = openDialog();
    choose("Snowflake");
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("user"), { target: { value: "SVC" } });
    fireEvent.change(field("warehouse"), { target: { value: "STUDIO_PROBE_WH" } });
    choose("Databend");
    expect(field("warehouse").value).toBe("");
    expect(field("user").value).toBe("");
    fireEvent.change(field("host"), { target: { value: "databend.internal" } });
    fireEvent.change(field("user"), { target: { value: "cloudapp" } });
    await click("Test Connection");
    expect(probe).toHaveBeenCalledTimes(1);
    const sent = probe.mock.calls[0][0];
    expect(sent).not.toHaveProperty("warehouse");
    expect(sent.user).toBe("cloudapp");
  });
});

describe("the Private key box draws no key once one is entered (SF-014)", () => {
  const KEY = `${pemArmour("BEGIN")}\nK-SENTINEL-BODY\n${pemArmour("END")}`;

  function enterKey() {
    const box = field("privateKey");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: KEY } });
  }

  test("a typed key shows while the box has focus and is hidden when it is left, and is still the one sent", async () => {
    const { probe } = openSnowflake();
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    enterKey();
    expect(field("privateKey").value).toBe(KEY);
    fireEvent.blur(field("privateKey"));
    expect(document.getElementById("privateKey")).toBeNull();
    expect(screen.getByTestId("privateKey-stored").textContent).toContain("A private key is entered. It is not shown.");
    expect(everythingDrawn()).not.toContain("K-SENTINEL-BODY");
    await click("Test Connection");
    expect(probe.mock.calls[0][0].privateKey).toBe(KEY);
  });

  test("a pasted key is hidden at once", () => {
    openSnowflake();
    const box = field("privateKey");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: KEY } });
    fireEvent.paste(box);
    expect(document.getElementById("privateKey")).toBeNull();
    expect(everythingDrawn()).not.toContain("K-SENTINEL-BODY");
  });

  test("Show key draws the key again, and Replace key empties the box for a new one", () => {
    openSnowflake();
    enterKey();
    fireEvent.blur(field("privateKey"));
    fireEvent.click(screen.getByRole("button", { name: "Show key" }));
    expect(field("privateKey").value).toBe(KEY);
    fireEvent.blur(field("privateKey"));
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(field("privateKey").value).toBe("");
    expect(document.activeElement).toBe(field("privateKey"));
  });

  test("Edit opens with the saved key hidden, and Save Changes keeps it", async () => {
    const probe = mock(async (_connection: DatabaseConnection) => ({ success: true }));
    const onConnect = mock((_connection: DatabaseConnection) => {});
    const saved: DatabaseConnection = {
      id: "sf-1",
      name: "sf",
      type: "snowflake",
      host: "myorg-myacct",
      user: "studio_svc",
      role: "STUDIO_RO",
      authMethod: "keypair",
      privateKey: KEY,
      privateKeyPassphrase: "P-SENTINEL",
      createdAt: new Date(0),
    };
    render(
      <ConnectionModal
        isOpen
        onClose={() => {}}
        onConnect={onConnect}
        editConnection={saved}
        onTestConnection={probe}
      />,
    );
    expect(document.getElementById("privateKey")).toBeNull();
    expect(screen.getByTestId("privateKey-stored")).toBeDefined();
    expect(everythingDrawn()).not.toContain("K-SENTINEL-BODY");
    expect(field("privateKeyPassphrase").type).toBe("password");
    await click("Save Changes");
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0][0]).toMatchObject({ privateKey: KEY, privateKeyPassphrase: "P-SENTINEL" });
  });
});

describe("the paste box's hint and its refusal name the same formats (SF-024)", () => {
  test("an unparsed text is refused with the list the hint shows, the Snowflake forms included", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste URL" }));
    const hint = screen.getByTestId("paste-formats").textContent ?? "";
    expect(hint.startsWith("Supports: ")).toBe(true);
    const formats = hint.slice("Supports: ".length);
    for (const form of ["jdbc:snowflake://", "snowflake://", "a Snowflake account URL", "couchbase://", "http(s)://"]) {
      expect(formats).toContain(form);
    }
    const box = document.querySelector('input[placeholder^="postgres://"]') as HTMLInputElement;
    fireEvent.change(box, { target: { value: "zz-libredbtest-nonexistent123" } });
    fireEvent.click(screen.getByRole("button", { name: "Parse" }));
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      `Could not parse connection string. Supported formats: ${formats}`,
    );
  });
});

describe("the Account hint and Test agree (SF-025)", () => {
  test("a text Test refuses gets no hint, and its refusal is drawn under the box until the box is edited", async () => {
    const { probe } = openSnowflake();
    fireEvent.change(field("host"), { target: { value: "https://myorg-myacct.snowflakecomputing.com/console" } });
    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    fireEvent.change(field("privateKey"), { target: { value: pemArmour("BEGIN") } });
    expect(screen.queryByTestId("host-hint")?.textContent ?? "").not.toContain("Studio connects to");
    await click("Test Connection");
    expect(probe).toHaveBeenCalledTimes(0);
    const sentence =
      "Enter an account identifier such as myorg-myaccount, or its https URL; a jdbc: or snowflake:// URL goes into Paste URL instead. Nothing was sent.";
    expect(screen.getByTestId("host-error").textContent).toBe(sentence);
    expect(field("host").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field("host"), { target: { value: "  myorg-myacct " } });
    expect(screen.queryByTestId("host-error")).toBeNull();
    expect(screen.getByTestId("host-hint").textContent).toBe("Studio connects to myorg-myacct.snowflakecomputing.com.");
    await click("Test Connection");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("the Snowflake form's small consistencies (SF-043)", () => {
  test("Account's example fits its box, and the URL form is said in the hint under it", () => {
    openSnowflake();
    expect(field("host").placeholder).toBe("myorg-myaccount");
    expect(screen.getByTestId("host-hint").textContent).toBe(
      "An account identifier such as myorg-myaccount, or its https:// URL.",
    );
  });

  test("User, Database and Schema keep spell checking, autocorrect, autocapitalise and autocomplete off", () => {
    openSnowflake();
    for (const id of ["user", "database", "schema", "warehouse", "role", "host"]) {
      const box = field(id);
      expect([id, box.getAttribute("spellcheck"), box.getAttribute("autocomplete")]).toEqual([id, "false", "off"]);
      expect([id, box.getAttribute("autocorrect"), box.getAttribute("autocapitalize")]).toEqual([id, "off", "off"]);
    }
  });

  test("the fields Test refuses empty are marked required, and the optional ones are not", () => {
    openSnowflake();
    const required = (id: string) => field(id).getAttribute("aria-required");
    const marked = (id: string) =>
      (document.querySelector(`label[for="${id}"]`) as HTMLElement).className.includes("after:content-['*']");
    for (const id of ["host", "user", "privateKey", "role"])
      expect([id, required(id), marked(id)]).toEqual([id, "true", true]);
    for (const id of ["privateKeyPassphrase", "warehouse", "database", "schema"]) {
      expect([id, required(id), marked(id)]).toEqual([id, null, false]);
    }
    fireEvent.change(field("authMethod"), { target: { value: "pat" } });
    expect([required("password"), marked("password")]).toEqual(["true", true]);
  });

  test("a Test result is withdrawn when any field changes, the key included", async () => {
    openSnowflake();
    fireEvent.change(field("host"), { target: { value: "myorg-myacct" } });
    fireEvent.change(field("user"), { target: { value: "studio_svc" } });
    fireEvent.change(field("role"), { target: { value: "STUDIO_RO" } });
    await click("Test Connection");
    expect(screen.getByTestId("connection-test-result").textContent).toContain("Paste the private key");
    fireEvent.change(field("privateKey"), { target: { value: pemArmour("BEGIN") } });
    await waitFor(() => expect(screen.queryByTestId("connection-test-result")).toBeNull());
    await click("Test Connection");
    expect(screen.queryByTestId("connection-test-result")).not.toBeNull();
    fireEvent.change(field("warehouse"), { target: { value: "WH" } });
    await waitFor(() => expect(screen.queryByTestId("connection-test-result")).toBeNull());
  });
});
