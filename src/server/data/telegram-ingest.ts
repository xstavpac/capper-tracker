// One Telegram batch, end to end (the work behind POST /api/ingest/telegram): the shared ingest core (ingest-batch.ts)
// with the Telegram batch key (channelId, messageId) and the Telegram rules:
//   - realTimeIngest: true - the message is imported as it arrives, so a game already final now was final when it was
//     posted and is never matched; review choices are matched by the same rule.
//   - picks go to the user's active pick recipients (no skipRecipientFanOut), no day rule, no per-line listener.
// The batch row is written BEFORE any parsing, so the raw text is never lost, and (channelId, messageId) makes a
// re-POST a no-op.
import { ingestBatch, isInfraError, type IngestResponse } from "@/server/data/ingest-batch";

export { isInfraError };
export type { IngestResponse };

export type IngestBatchInput = { channelId: string; messageId: number; day: string; text: string };
export type IngestConfig = { userId: string; allowedLeagues: Set<string> };

export async function ingestTelegramBatch(input: IngestBatchInput, config: IngestConfig): Promise<IngestResponse> {
  const { channelId, messageId, day, text } = input;
  return ingestBatch(
    { type: "TELEGRAM", channelId, messageId },
    { userId: config.userId, day, text },
    { allowedLeagues: config.allowedLeagues, realTimeIngest: true }
  );
}
