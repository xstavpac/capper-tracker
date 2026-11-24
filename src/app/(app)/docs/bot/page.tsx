import type { Metadata } from "next";
import { PageBanner } from "@/components/dashboard/page-banner";
import { ThemedPage } from "@/components/dashboard/themed-page";
import { BotGuide } from "@/components/docs/bot-guide";

// /docs/bot - the Bot Guide, linked from Settings › API tokens ("Read the bot guide →"). Static: no data reads.
// Inside the (app) group, so it has the signed-in shell like the Settings page that links here.
export const metadata: Metadata = { title: "Bot Guide · BettingView" };

export default function BotGuidePage() {
  return (
    <>
      <PageBanner variant="import" title="Bot Guide" motto="YOUR BOT · YOUR LEDGER" />
      <ThemedPage>
        <BotGuide />
      </ThemedPage>
    </>
  );
}
