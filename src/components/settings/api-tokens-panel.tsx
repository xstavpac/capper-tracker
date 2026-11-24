"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { createApiToken, listApiTokens, revokeApiToken } from "@/server/actions/api-tokens";
import type { ApiTokenListItem } from "@/server/data/api-tokens";
import { FOOTER_LINK, PanelShell, RED, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon, CopyIcon, KeyIcon, ListChecksIcon } from "@/components/dashboard/cappers-icons";
import {
  API_TOKEN_LEAGUES,
  API_TOKEN_RATE_PER_MINUTE,
  API_TOKEN_UI_MAX_ACTIVE,
  API_TOKEN_UI_NAME_MAX,
  NETWORK_MESSAGE,
  REVOKE_FAILED_MESSAGE,
  TOKEN_NAME_MESSAGE,
  createErrorMessage,
  formatLastUsed,
  isValidTokenName,
  maskedToken,
} from "@/lib/api-token-ui";
import { formatEastern } from "@/lib/dates";

// Settings › API tokens. Uses the PR 2 server actions only. The raw token lives in this component's state from the
// create result until the component unmounts (navigation) or another token is created: it is never written to
// storage, the URL, or the token list.

const PANEL_ICON = "h-[17px] w-[17px] stroke-[2.2]";
// 44px touch targets everywhere a finger lands.
const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-3.5 text-sm font-semibold disabled:opacity-50";
const BRAND_BTN = BTN + " bg-[#2563EB] text-white hover:bg-[#1D4ED8]";
const PLAIN_BTN = BTN + " border border-[#DADDE5] bg-white text-foreground hover:bg-foreground/[0.035] dark:border-border dark:bg-card";
const REVOKE_BTN = BTN + " border border-[#F3CACA] bg-white hover:bg-[#FFF7F7] dark:border-red-400/40 dark:bg-transparent dark:hover:bg-red-500/10 " + RED;
const INPUT = "min-h-11 rounded-[10px] border border-[#DADDE5] bg-white px-3 text-sm text-foreground dark:border-border dark:bg-background";
const ERROR_TEXT = "text-xs font-medium " + RED;
const CELL = "px-3 py-2 align-middle";

type Created = { name: string; rawToken: string };

export function ApiTokensPanel({ initialTokens, nowMs }: { initialTokens: ApiTokenListItem[]; nowMs: number }) {
  const [tokens, setTokens] = useState(initialTokens);
  const [now, setNow] = useState(nowMs);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function refresh() {
    setTokens(await listApiTokens());
    setNow(Date.now());
  }

  function startCreate() {
    setNaming(true);
    setName("");
    setError(null);
    setCreated(null);
    setCopied(false);
  }

  function cancelCreate() {
    setNaming(false);
    setName("");
    setError(null);
  }

  function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidTokenName(name)) {
      setError(TOKEN_NAME_MESSAGE);
      return;
    }
    startTransition(async () => {
      try {
        const result = await createApiToken(name);
        if (!result.ok) {
          setError(createErrorMessage(result.error));
          return;
        }
        setCreated({ name: result.name, rawToken: result.rawToken });
        setNaming(false);
        setName("");
        await refresh();
      } catch {
        setError(NETWORK_MESSAGE);
      }
    });
  }

  function confirmRevoke(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await revokeApiToken(id);
        setConfirmId(null);
        if (!result.ok) setError(REVOKE_FAILED_MESSAGE);
        await refresh();
      } catch {
        setError(NETWORK_MESSAGE);
      }
    });
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.rawToken);
      setCopied(true);
    } catch {
      // No clipboard permission: select the text so the user can copy it by hand.
      tokenRef.current?.select();
    }
  }

  const subtitle = (
    <>
      Let your own bot send picks to BettingView. Picks sent with a token go only into your ledger. Your bot reads your
      sources; we match, grade, and send anything unclear to{" "}
      <Link href="/picks/import" className="font-semibold text-brand-600 hover:underline dark:text-brand-400">
        Needs review
      </Link>
      .
    </>
  );

  return (
    <div className="space-y-4">
      <PanelShell
        theme={{ ...TINTS.blue, title: "API tokens", subtitle, icon: <KeyIcon className={PANEL_ICON} /> }}
        control={
          <button type="button" onClick={startCreate} disabled={pending || naming} className={BRAND_BTN + " ml-auto"}>
            Create token
          </button>
        }
        wrapSubtitle
        wrapControl
        footer={undefined}
      >
        {naming && (
          <form onSubmit={submitCreate} className="mb-3 flex flex-wrap items-center gap-2" aria-label="Create token">
            <label htmlFor="api-token-name" className="sr-only">
              Token name
            </label>
            <input
              id="api-token-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              placeholder={`Token name (1–${API_TOKEN_UI_NAME_MAX} characters)`}
              autoComplete="off"
              className={INPUT + " min-w-0 flex-1 basis-56"}
            />
            <button type="submit" disabled={pending} className={BRAND_BTN}>
              {pending ? "Creating..." : "Create"}
            </button>
            <button type="button" onClick={cancelCreate} disabled={pending} className={PLAIN_BTN}>
              Cancel
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className={"mb-3 " + ERROR_TEXT}>
            {error}
          </p>
        )}

        {created && (
          <div role="status" className={"mb-3 rounded-[12px] border p-3 " + TINTS.green.card}>
            <p className="text-sm font-medium text-foreground">
              Token &quot;{created.name}&quot; created. Copy it now; you won&apos;t see it again.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label htmlFor="api-token-raw" className="sr-only">
                New token
              </label>
              <input
                id="api-token-raw"
                ref={tokenRef}
                readOnly
                value={created.rawToken}
                onFocus={(e) => e.currentTarget.select()}
                className={INPUT + " min-w-0 flex-1 basis-64 font-mono text-[13px]"}
              />
              <button type="button" onClick={copyToken} className={PLAIN_BTN}>
                <CopyIcon className="h-4 w-4" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        <div className="relative overflow-x-auto rounded-[12px] border border-[#E6E8EE] bg-white dark:border-border dark:bg-card">
          {tokens.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] font-medium text-muted-foreground">No tokens yet.</p>
          ) : (
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-[#0F1420]/[0.08] text-xs font-semibold text-muted-foreground dark:border-white/10">
                  <th scope="col" className={CELL}>Name</th>
                  <th scope="col" className={CELL}>Token</th>
                  <th scope="col" className={CELL}>Created</th>
                  <th scope="col" className={CELL}>Last used</th>
                  <th scope="col" className={CELL + " text-right"}>Picks (7d)</th>
                  <th scope="col" className={CELL + " text-right"}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orderTokens(tokens).map((t) => {
                  const revoked = t.revokedAt !== null;
                  return (
                    <tr
                      key={t.id}
                      data-token-id={t.id}
                      data-revoked={revoked ? "true" : undefined}
                      className={"border-b border-[#0F1420]/[0.06] last:border-0 dark:border-white/5 " + (revoked ? "text-muted-foreground opacity-60" : "text-foreground")}
                    >
                      <td className={CELL + " max-w-[200px] truncate font-medium"}>{t.name}</td>
                      <td className={CELL + " whitespace-nowrap font-mono text-[13px]"}>{maskedToken(t.prefix)}</td>
                      <td className={CELL + " whitespace-nowrap"}>{formatEastern(t.createdAt, { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td className={CELL + " whitespace-nowrap"}>{formatLastUsed(t.lastUsedAt, now)}</td>
                      <td className={CELL + " text-right tabular-nums"}>{t.picksLast7Days}</td>
                      <td className={CELL + " whitespace-nowrap text-right"}>
                        {revoked ? (
                          <span className="text-xs font-semibold">Revoked</span>
                        ) : confirmId === t.id ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">Revoke? Bots using it stop working.</span>
                            <button type="button" onClick={() => confirmRevoke(t.id)} disabled={pending} className={REVOKE_BTN}>
                              Confirm
                            </button>
                            <button type="button" onClick={() => setConfirmId(null)} disabled={pending} className={PLAIN_BTN}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirmId(t.id)} disabled={pending} aria-label={`Revoke ${t.name}`} className={REVOKE_BTN}>
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </PanelShell>

      <div className="grid gap-4 sm:grid-cols-2">
        <PanelShell theme={{ ...TINTS.neutral, title: "Limits", subtitle: null, icon: <ListChecksIcon className={PANEL_ICON} /> }} footer={undefined}>
          <ul className="space-y-1.5 pl-[38px] text-sm text-foreground">
            <li>{API_TOKEN_RATE_PER_MINUTE} requests a minute per token</li>
            <li>Up to {API_TOKEN_UI_MAX_ACTIVE} active tokens</li>
            <li>{API_TOKEN_LEAGUES.join(", ")}</li>
          </ul>
        </PanelShell>
        <PanelShell
          theme={{
            ...TINTS.violet,
            title: "Setting up a bot?",
            subtitle: "The guide covers the endpoint, the pick format, and how your bot can fix picks that need review.",
            icon: <BoltIcon className={PANEL_ICON} />,
          }}
          wrapSubtitle
          footer={
            <Link href="/docs/bot" className={FOOTER_LINK + " inline-flex min-h-11 items-center " + TINTS.violet.accent}>
              Read the bot guide →
            </Link>
          }
        >
          {null}
        </PanelShell>
      </div>
    </div>
  );
}

/** Active rows first (keeping the server's newest-first order within each group). */
function orderTokens(tokens: ApiTokenListItem[]): ApiTokenListItem[] {
  return [...tokens.filter((t) => t.revokedAt === null), ...tokens.filter((t) => t.revokedAt !== null)];
}
