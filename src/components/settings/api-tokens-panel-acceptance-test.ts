// Settings › API tokens (api-tokens-panel.tsx, api-token-ui.ts). Two halves:
//   1. The pure words: name rule, error messages, "Last used", masked token.
//   2. The real panel on jsdom, with the three server actions replaced by an in-memory fake: the empty state,
//      create showing the raw token once (and never in the table), name validation, the 5-active-tokens limit,
//      a network failure, revoke behind an inline confirm (Cancel does nothing), revoked rows greyed with
//      "Revoked" instead of the button, active rows first, and Copy's feedback.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/components/settings/api-tokens-panel-acceptance-test.ts
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { ApiTokenListItem, CreateApiTokenResult, RevokeApiTokenResult } from "@/server/data/api-tokens";
import {
  NETWORK_MESSAGE,
  TOKEN_LIMIT_MESSAGE,
  TOKEN_NAME_MESSAGE,
  createErrorMessage,
  formatLastUsed,
  isValidTokenName,
  maskedToken,
} from "@/lib/api-token-ui";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const eq = (label: string, actual: unknown, expected: unknown) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

// ---- 1 · The words ------------------------------------------------------------------------------
const NOW = Date.parse("2026-11-24T18:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms);
const MIN = 60_000;
eq("name rule", [isValidTokenName(""), isValidTokenName("   "), isValidTokenName("bot"), isValidTokenName("x".repeat(40)), isValidTokenName("x".repeat(41)), isValidTokenName("  " + "x".repeat(40) + "  ")], [false, false, true, true, false, true]);
eq("name rule counts code points", isValidTokenName("🏀".repeat(40)), true);
eq("create errors", [createErrorMessage("token_limit"), createErrorMessage("invalid_name")], [TOKEN_LIMIT_MESSAGE, TOKEN_NAME_MESSAGE]);
eq("limit message", TOKEN_LIMIT_MESSAGE, "You can have up to 5 active tokens. Revoke one to create another.");
eq(
  "last used",
  [null, ago(10_000), ago(MIN), ago(5 * MIN), ago(60 * MIN), ago(2 * 60 * MIN + 59 * MIN), ago(24 * 60 * MIN), ago(3 * 24 * 60 * MIN)].map((d) => formatLastUsed(d, NOW)),
  ["Never", "just now", "1 minute ago", "5 minutes ago", "1 hour ago", "2 hours ago", "1 day ago", "3 days ago"]
);
eq("masked token", maskedToken("bv_live_ab12"), "bv_live_ab12••••");

// ---- 2 · The panel ------------------------------------------------------------------------------
let store: ApiTokenListItem[] = [];
let nextId = 1;
let failNext = false;
const calls: string[] = [];
const RAW = "bv_live_ab12SECRETSECRETSECRETSECRET";
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/api-tokens", {
  createApiToken: async (name: string): Promise<CreateApiTokenResult> => {
    calls.push("create:" + name);
    if (failNext) {
      failNext = false;
      throw new TypeError("Failed to fetch");
    }
    if (!isValidTokenName(name)) return { ok: false, error: "invalid_name" };
    if (store.filter((t) => !t.revokedAt).length >= 5) return { ok: false, error: "token_limit" };
    const id = "tok" + nextId++;
    const createdAt = new Date(NOW);
    store = [{ id, name: name.trim(), prefix: "bv_live_ab12", createdAt, lastUsedAt: null, revokedAt: null, picksLast7Days: 0 }, ...store];
    return { ok: true, id, name: name.trim(), prefix: "bv_live_ab12", createdAt, rawToken: RAW };
  },
  revokeApiToken: async (id: string): Promise<RevokeApiTokenResult> => {
    calls.push("revoke:" + id);
    const t = store.find((x) => x.id === id);
    if (!t) return { ok: false, error: "not_found" };
    t.revokedAt ??= new Date(NOW);
    return { ok: true };
  },
  listApiTokens: async (): Promise<ApiTokenListItem[]> => {
    calls.push("list");
    // The server's order: active newest first, then revoked.
    return [...store.filter((t) => !t.revokedAt), ...store.filter((t) => t.revokedAt)].map((t) => ({ ...t }));
  },
});

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/settings" });
  const win = dom.window;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.self = win;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  let clipboard = "";
  Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async (s: string) => void (clipboard = s) }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  g.React = React;
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { ApiTokensPanel } = await import("./api-tokens-panel");
  const h = React.createElement;
  const act = (fn: () => void | Promise<void>) => React.act(async () => fn());
  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  };
  const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {} };

  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  const text = () => el.textContent ?? "";
  const button = (label: string, scope: ParentNode = el) =>
    Array.from(scope.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
  const click = async (b: Element | undefined | null) => {
    if (!b) throw new Error("no such control");
    await act(() => void (b as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
    await settle();
  };
  const type = async (input: HTMLInputElement | null, value: string) => {
    if (!input) throw new Error("no input");
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    await act(() => {
      setter.call(input, value);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    const form = el.querySelector('form[aria-label="Create token"]');
    if (!form) throw new Error("no create form");
    await act(() => void form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
  };
  const nameInput = () => el.querySelector<HTMLInputElement>("#api-token-name");
  const rawInput = () => el.querySelector<HTMLInputElement>("#api-token-raw");
  const alert = () => el.querySelector('[role="alert"]')?.textContent ?? null;
  const rows = () => Array.from(el.querySelectorAll<HTMLTableRowElement>("tbody tr"));
  const create = async (name: string) => {
    await click(button("Create token"));
    await type(nameInput(), name);
    await submit();
  };

  let root!: Root;
  const mount = async (tokens: ApiTokenListItem[]) => {
    await act(() => {
      root = createRoot(el);
      root.render(h(AppRouterContext.Provider, { value: router as never }, h(ApiTokensPanel, { initialTokens: tokens, nowMs: NOW })));
    });
    await settle();
  };
  const unmount = async () => act(() => root.unmount());

  // Empty state, and the panel's fixed text.
  await mount([]);
  check("empty state", text().includes("No tokens yet.") && rows().length === 0);
  check("title + subtitle", text().includes("API tokens") && text().includes("Picks sent with a token go only into your ledger."));
  check("Needs review links to /picks/import", Array.from(el.querySelectorAll("a")).some((a) => a.textContent === "Needs review" && a.getAttribute("href") === "/picks/import"));
  check("bot guide links to /docs/bot", Array.from(el.querySelectorAll("a")).some((a) => (a.textContent ?? "").includes("Read the bot guide") && a.getAttribute("href") === "/docs/bot"));
  check("limits card", text().includes("60 requests a minute per token") && text().includes("Up to 5 active tokens") && text().includes("NBA, NFL, NCAAB, NCAAF, NHL, WNBA, MLB"));

  // Name validation: blank never reaches the server; Cancel closes the form.
  await click(button("Create token"));
  check("name form opens", nameInput() !== null);
  await type(nameInput(), "   ");
  await submit();
  eq("blank name: inline error", alert(), TOKEN_NAME_MESSAGE);
  check("blank name: no server call", !calls.some((c) => c.startsWith("create:")));
  await type(nameInput(), "x".repeat(41));
  await submit();
  eq("41 chars: inline error", alert(), TOKEN_NAME_MESSAGE);
  await click(button("Cancel"));
  check("Cancel closes the form and clears the error", nameInput() === null && alert() === null);

  // Network failure.
  failNext = true;
  await create("My bot");
  eq("network failure: inline error", alert(), NETWORK_MESSAGE);
  check("network failure: form stays open, no token shown", nameInput() !== null && rawInput() === null);
  await click(button("Cancel"));

  // Create: the raw token shows once, in the green box only.
  await create("My bot");
  check("create: success box", text().includes('Token "My bot" created. Copy it now; you won\'t see it again.'));
  eq("create: raw token in read-only input", [rawInput()?.value, rawInput()?.readOnly], [RAW, true]);
  check("create: form closed", nameInput() === null);
  eq("create: one row", rows().length, 1);
  const row0 = rows()[0];
  check("create: row masks the token", (row0.textContent ?? "").includes("bv_live_ab12••••") && !(row0.textContent ?? "").includes("SECRET"));
  check("create: row says Never + 0 picks", (row0.textContent ?? "").includes("Never") && row0.cells[4].textContent === "0");
  await click(button("Copy"));
  check("copy: clipboard + Copied feedback", clipboard === RAW && button("Copied") !== undefined);
  check("token not in storage", win.localStorage.length === 0 && win.sessionStorage.length === 0 && !win.location.href.includes("SECRET"));

  // Starting another create hides the earlier token.
  await click(button("Create token"));
  check("next create hides the raw token", rawInput() === null && !text().includes("SECRET"));
  await click(button("Cancel"));
  await unmount();

  // Navigating away and back: the token is gone.
  await mount(store.map((t) => ({ ...t })));
  check("remount: raw token never shown again", rawInput() === null && !text().includes("SECRET") && rows().length === 1);

  // The 5-active-tokens limit.
  for (const n of ["b2", "b3", "b4", "b5"]) await create(n);
  eq("five active rows", rows().filter((r) => !r.dataset.revoked).length, 5);
  await create("b6");
  eq("limit: inline error", alert(), "You can have up to 5 active tokens. Revoke one to create another.");
  check("limit: no new token shown", rawInput() === null && rows().length === 5);
  await click(button("Cancel"));

  // Revoke behind a confirm.
  const target = rows().find((r) => r.cells[0].textContent === "b3")!;
  await click(button("Revoke b3", target));
  check("revoke: confirm text", (target.textContent ?? "").includes("Revoke? Bots using it stop working."));
  const before = calls.filter((c) => c.startsWith("revoke:")).length;
  await click(button("Cancel", target));
  check("revoke: Cancel calls nothing, button returns", calls.filter((c) => c.startsWith("revoke:")).length === before && button("Revoke b3", target) !== undefined);
  await click(button("Revoke b3", target));
  await click(button("Confirm", rows().find((r) => r.cells[0].textContent === "b3")));
  check("revoke: action called with the token id", calls.includes("revoke:" + store.find((t) => t.name === "b3")!.id));

  // Revoked row rendering + active rows first.
  const all = rows();
  const revokedRow = all.find((r) => r.cells[0].textContent === "b3")!;
  check("revoked row: greyed", revokedRow.dataset.revoked === "true" && revokedRow.className.includes("opacity-60"));
  check("revoked row: 'Revoked', no button", revokedRow.cells[5].textContent === "Revoked" && revokedRow.querySelector("button") === null);
  eq("active rows first", all.map((r) => r.dataset.revoked ?? "active"), ["active", "active", "active", "active", "true"]);
  await create("b6");
  check("after a revoke the limit frees a slot", rawInput()?.value === RAW && alert() === null);
  await unmount();

  // Out-of-order input (e.g. a stale list) still renders active first; Last used + Picks (7d) from the data.
  await mount([
    { id: "r1", name: "old", prefix: "bv_live_zz99", createdAt: new Date(NOW - 9 * 864e5), lastUsedAt: new Date(NOW - 3 * 864e5), revokedAt: new Date(NOW - 864e5), picksLast7Days: 4 },
    { id: "a1", name: "live", prefix: "bv_live_aa11", createdAt: new Date(NOW - 864e5), lastUsedAt: new Date(NOW - 2 * 3600e3), revokedAt: null, picksLast7Days: 12 },
  ]);
  eq("order from mixed input", rows().map((r) => r.cells[0].textContent), ["live", "old"]);
  eq("active row cells", Array.from(rows()[0].cells).slice(1, 5).map((c) => c.textContent), ["bv_live_aa11••••", "Nov 23, 2026", "2 hours ago", "12"]);
  await unmount();

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
