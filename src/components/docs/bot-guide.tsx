import Link from "next/link";
import type { ReactNode } from "react";
import { TINTS } from "@/components/dashboard/panel-shell";
import { CodeBlock } from "@/components/docs/code-block";
import {
  BOT_API_URL,
  BOT_LIMITS,
  BOT_TOKEN_PREFIX,
  CURL_EXAMPLE,
  DAY_RULES,
  EXAMPLE_BODY,
  EXAMPLE_RESPONSE,
  HTTP_ROWS,
  LLM_PROMPT_EXAMPLE,
  LLM_TIPS,
  NODE_EXAMPLE,
  PYTHON_EXAMPLE,
  REJECT_REASONS,
  REVIEW_REASONS,
  STATUS_ROWS,
} from "@/lib/bot-guide-content";

// The Bot Guide (/docs/bot): how a user's own bot sends picks to POST /api/v1/picks with an API token. The layout is
// the approved mockup's (an "On this page" card beside numbered, tinted section cards); the look is the site's
// (ThemedPage backdrop, PanelShell tints, which carry the dark-mode treatment). Every fact comes from
// lib/bot-guide-content.ts, which a test pins to the endpoint's code.

const SECTIONS = [
  { id: "token", title: "Get a token" },
  { id: "request", title: "Send picks" },
  { id: "format", title: "Pick text format" },
  { id: "matching", title: "What happens to your picks" },
  { id: "response", title: "Reading the response" },
  { id: "limits", title: "Limits and errors" },
  { id: "prompting", title: "Prompting your own AI" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const BODY = "text-sm font-medium leading-relaxed text-[#3A4152] dark:text-foreground/80";
const LINK = "font-semibold text-brand-600 hover:underline dark:text-brand-400";
const CARD_WHITE =
  "rounded-[18px] border border-transparent bg-white shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border-border dark:bg-card dark:shadow-none";
const SUB_CARD = "rounded-[14px] bg-white p-3 dark:bg-white/[0.04]";
const ROW_RULE = "border-b border-[#0F1420]/[0.06] last:border-0 dark:border-white/10";

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="break-words rounded-[5px] bg-[#E6ECFF] px-1.5 py-0.5 font-mono text-[12.5px] text-[#1D4FD8] dark:bg-brand-500/15 dark:text-brand-300">
      {children}
    </code>
  );
}

function Section({ id, n, children }: { id: SectionId; n: number; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === id)!.title;
  return (
    <section id={id} aria-labelledby={id + "-title"} className={"scroll-mt-24 rounded-[18px] border px-4 pb-4 pt-3.5 " + TINTS.blue.card}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={"flex h-[26px] w-[26px] shrink-0 items-center justify-center text-[13px] font-bold " + TINTS.blue.iconWrap}>
          {n}
        </span>
        <h2 id={id + "-title"} className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h2>
      </div>
      {/* Indented under the title on wider screens; full width on a phone, where 38px is too much to give up. */}
      <div className="mt-2 flex min-w-0 flex-col gap-3 sm:pl-[38px]">{children}</div>
    </section>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-semibold text-foreground">{children}</h3>;
}

// A two-column list that stacks on a phone (never a table that scrolls sideways).
function TermList({ rows }: { rows: { term: ReactNode; text: ReactNode }[] }) {
  return (
    <dl className={SUB_CARD + " py-1"}>
      {rows.map((r, i) => (
        <div key={i} className={"grid gap-x-4 gap-y-1 py-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] " + ROW_RULE}>
          <dt className="min-w-0">{r.term}</dt>
          <dd className={BODY + " min-w-0"}>{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_TONE: Record<string, string> = {
  accepted: TINTS.green.card + " " + "text-[#15803D] dark:text-emerald-400",
  needs_review: TINTS.orange.card + " " + "text-[#C2410C] dark:text-orange-400",
  rejected: TINTS.red.card + " " + "text-[#B91C1C] dark:text-red-400",
};

const FORMAT_EXAMPLES: { what: string; example: string }[] = [
  { what: "Moneyline", example: "Yankees ML" },
  { what: "Spread", example: "Chiefs -3.5" },
  { what: "Game total", example: "Dodgers u 8.5" },
  { what: "With the capper's odds", example: "Yankees ML -132" },
  { what: "League in front", example: "NFL Giants +6.5" },
  { what: "Doubleheader game", example: "Cubs ML Gm 2" },
  { what: "Player prop", example: "Jahmyr Gibbs over 65.5 rush yds" },
  { what: "A named day", example: "Chiefs -3.5 Thursday" },
];

export function BotGuide() {
  return (
    <div className="flex flex-col gap-3.5 lg:flex-row lg:items-start">
      <nav aria-label="On this page" className={CARD_WHITE + " p-2 lg:sticky lg:top-24 lg:w-60 lg:shrink-0"}>
        <div className="px-3 pb-1 pt-2 text-xs font-semibold text-[#5B6275] dark:text-muted-foreground">On this page</div>
        <ol className="flex flex-wrap gap-0.5 lg:flex-col">
          {SECTIONS.map((s, i) => (
            <li key={s.id}>
              <a
                href={"#" + s.id}
                className="flex min-h-10 items-center rounded-[10px] px-3 text-sm font-semibold text-[#3A4152] hover:bg-foreground/[0.04] dark:text-foreground/80"
              >
                {i + 1}. {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <section aria-label="What this is" className={CARD_WHITE + " px-5 py-4"}>
          <p className={BODY + " text-[15px]"}>
            Run your own bot, with your own AI key (GPT, Claude or anything else), that reads the sources you follow and
            sends the picks straight into your BettingView ledger. BettingView matches each pick to a game, grades it, and
            tracks the capper&apos;s record, the same way Catalog Import does. Picks sent with your token only ever go to
            your account.
          </p>
          <p className={BODY + " mt-2"}>
            We provide the endpoint, your token and this guide. Your bot, your prompts and your AI account are yours to run.
          </p>
        </section>

        <Section id="token" n={1}>
          <p className={BODY}>
            Go to{" "}
            <Link href="/settings" className={LINK}>
              Settings › API tokens
            </Link>{" "}
            and create a token. Give it a name you&apos;ll recognize: it shows on every pick it sends that lands in review.
          </p>
          <ul className={BODY + " list-disc space-y-1 pl-5"}>
            <li>
              The token starts with <Code>{BOT_TOKEN_PREFIX}</Code> and is shown once, when you create it. Copy it then. We
              only keep a fingerprint of it, so we can&apos;t show it again.
            </li>
            <li>Keep it in your bot&apos;s environment (for example BETTINGVIEW_TOKEN), never in code you share.</li>
            <li>You can have up to {BOT_LIMITS.maxActiveTokens} active tokens. Revoke one to make room for another.</li>
            <li>Revoke a token any time. Requests with it stop working right away.</li>
          </ul>
        </Section>

        <Section id="request" n={2}>
          <p className={BODY}>
            Send a <Code>POST</Code> with a JSON body to <Code>{BOT_API_URL}</Code>, with your token in the{" "}
            <Code>Authorization: Bearer …</Code> header. One request carries one capper&apos;s picks.
          </p>
          <TermList
            rows={[
              { term: <Code>capper</Code>, text: `The capper's name, as you want it in your ledger. 1-${BOT_LIMITS.maxCapperChars} characters.` },
              { term: <Code>picks</Code>, text: `A list of 1-${BOT_LIMITS.maxPicksPerRequest} picks.` },
              {
                term: <Code>picks[].client_id</Code>,
                text: `Your own id for the pick, 1-${BOT_LIMITS.maxClientIdChars} characters, unique within the request. Sending the same client_id again never makes a second pick (see step 4).`,
              },
              { term: <Code>picks[].text</Code>, text: `The pick as one line of text, 1-${BOT_LIMITS.maxTextChars} characters (step 3).` },
            ]}
          />
          <p className={BODY}>The whole body can be up to {BOT_LIMITS.maxBodyKb} KB. No other fields are read.</p>
          <CodeBlock label="Request body" code={EXAMPLE_BODY} />
          <CodeBlock label="curl" code={CURL_EXAMPLE} />
          <CodeBlock label="Node.js" code={NODE_EXAMPLE} />
          <CodeBlock label="Python" code={PYTHON_EXAMPLE} />
          <p className={BODY}>
            A request with many picks can take a while, so give your HTTP client a timeout of at least {BOT_LIMITS.timeoutSeconds}{" "}
            seconds.
          </p>
        </Section>

        <Section id="format" n={3}>
          <p className={BODY}>
            Write each pick the way you&apos;d paste it into Catalog Import: one straight bet per line. The clearer the text,
            the fewer picks land in review.
          </p>
          <TermList rows={FORMAT_EXAMPLES.map((f) => ({ term: <span className="text-sm font-semibold text-foreground">{f.what}</span>, text: <Code>{f.example}</Code> }))} />
          <ul className={BODY + " list-disc space-y-1 pl-5"}>
            <li>Leagues: {BOT_LIMITS.leagues.join(", ")}.</li>
            <li>Put the league in front when a team name could mean two teams. It skips the &quot;which Giants?&quot; question.</li>
            <li>Odds are optional. Include the capper&apos;s price when there is one.</li>
            <li>Parlays and combined picks (&quot;Bears + Cubs&quot;) are rejected. Send each leg as its own pick if you want them tracked.</li>
          </ul>
          <p className={BODY}>
            Every format we read is listed under{" "}
            <Link href="/picks/import#formats" className={LINK}>
              Supported pick formats
            </Link>{" "}
            on Catalog Import.
          </p>
        </Section>

        <Section id="matching" n={4}>
          <p className={BODY}>
            Your picks go through the same matching as Catalog Import. Clear picks are saved and graded when the game ends.
            Picks sent after a game has started are accepted too.
          </p>
          <p className={BODY}>
            Picks that need a decision (which team, which player, which line) wait in <strong className="text-foreground">Needs review</strong> on{" "}
            <Link href="/picks/import" className={LINK}>
              Catalog Import
            </Link>
            . Each card shows the capper, the name of the token that sent it and the time, so you know which bot it came
            from. Answer it there with one tap.
          </p>
          <SubHeading>Which game a pick goes to</SubHeading>
          <ul className={BODY + " list-disc space-y-1 pl-5"}>
            {DAY_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <SubHeading>Sending a pick again</SubHeading>
          <ul className={BODY + " list-disc space-y-1 pl-5"}>
            <li>Already accepted: you get the same result back. Nothing new is saved.</li>
            <li>
              Waiting in review: the old review card is removed and the new text is matched instead. Use this to fix a pick
              from your bot, for example by adding a league in front.
            </li>
            <li>Rejected or dismissed: it is matched again from scratch.</li>
          </ul>
        </Section>

        <Section id="response" n={5}>
          <p className={BODY}>
            A request that&apos;s read returns HTTP 200 with one result per pick, in the order you sent them. Check each
            pick&apos;s <Code>status</Code>.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {STATUS_ROWS.map((s) => (
              <div key={s.status} className={"rounded-xl border px-3 py-2.5 " + STATUS_TONE[s.status]}>
                <div className="font-mono text-[13px] font-semibold">{s.status}</div>
                <div className={"mt-1 text-[13px] font-medium leading-snug text-[#3A4152] dark:text-foreground/80"}>{s.meaning}</div>
              </div>
            ))}
          </div>
          <CodeBlock label="Response" code={EXAMPLE_RESPONSE} />
          <p className={BODY}>
            <Code>market</Code> is one of MONEYLINE, SPREAD, TOTAL, TEAM_TOTAL, PLAYER_PROP or NRFI. <Code>game</Code> is
            null for a candidate that isn&apos;t matched to a game yet.
          </p>
          <SubHeading>needs_review reasons</SubHeading>
          <TermList rows={Object.entries(REVIEW_REASONS).map(([k, v]) => ({ term: <Code>{k}</Code>, text: v }))} />
          <SubHeading>rejected reasons</SubHeading>
          <TermList rows={Object.entries(REJECT_REASONS).map(([k, v]) => ({ term: <Code>{k}</Code>, text: v }))} />
        </Section>

        <Section id="limits" n={6}>
          <ul className={BODY + " list-disc space-y-1 pl-5"}>
            <li>{BOT_LIMITS.requestsPerMinute} requests a minute per token.</li>
            <li>
              {BOT_LIMITS.maxPicksPerRequest} picks and {BOT_LIMITS.maxBodyKb} KB per request. Batch picks into one request
              rather than sending one request per pick.
            </li>
            <li>
              After {BOT_LIMITS.badTokenAttemptsPerMinute} requests with a bad token in a minute from one address, that
              address is refused for the rest of the minute.
            </li>
            <li>Up to {BOT_LIMITS.maxActiveTokens} active tokens per account.</li>
          </ul>
          <SubHeading>HTTP responses</SubHeading>
          <dl className={SUB_CARD + " py-1"}>
            {HTTP_ROWS.map((r) => (
              <div key={r.code} className={"py-2.5 " + ROW_RULE}>
                <dt className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-sm font-bold text-foreground">{r.code}</span>
                  <Code>{r.body}</Code>
                </dt>
                <dd className={BODY + " mt-1"}>{r.meaning}</dd>
              </div>
            ))}
          </dl>
          <p className={BODY}>
            Retry a 429 or 503 with the same client_ids: picks that were already accepted come back as they were, so a retry
            is always safe.
          </p>
        </Section>

        <Section id="prompting" n={7}>
          <p className={BODY}>
            Most bots use an AI model to turn a capper&apos;s post into picks. A few things make its output match well:
          </p>
          <ul className={BODY + " list-disc space-y-1 pl-5"}>
            {LLM_TIPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <CodeBlock label="Example instructions for your AI" code={LLM_PROMPT_EXAMPLE} />
          <div className={"rounded-[14px] border px-3.5 py-3 " + TINTS.violet.card}>
            <p className={BODY}>
              <strong className="text-foreground">A note on support.</strong> Your bot runs on your own code and your own AI
              account, so we can&apos;t help set it up or debug it. Every response tells your bot what happened, so the
              status, the reason and the detail are the best place to start. If a request that follows this guide gets a
              response that doesn&apos;t match it, tell us with Report a bug in{" "}
              <Link href="/settings" className={LINK}>
                Settings
              </Link>{" "}
              and we&apos;ll look into the endpoint.
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}
