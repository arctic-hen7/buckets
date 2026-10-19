import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Project } from "./config";
import { googleJson, subscriberClient } from "./google";
import { errorMessage, log } from "./logger";

const pullSchema = z.object({
    receivedMessages: z
        .array(z.object({ ackId: z.string(), message: z.unknown().optional() }))
        .default([]),
});
const notificationSchema = z.object({
    emailAddress: z.email(),
    historyId: z.string().regex(/^\d+$/),
});

export function notificationEmail(message: unknown): string {
    const { data } = z.object({ data: z.string() }).parse(message);
    return notificationSchema
        .parse(JSON.parse(Buffer.from(data, "base64url").toString("utf8")))
        .emailAddress.toLowerCase();
}

/** One outbound pull loop per Google project; no public webhook or queue */
export async function listen(
    projectName: string,
    project: Project,
    synchronize: (emails: Set<string>) => Promise<void>,
    signal: AbortSignal,
): Promise<void> {
    const auth = subscriberClient(project);
    const url = `https://pubsub.googleapis.com/v1/projects/${project.project_id}/subscriptions/${project.subscription}`;
    while (!signal.aborted) {
        try {
            const token = await auth.getAccessToken();
            if (!token) throw new Error("No Pub/Sub access token");
            const result = pullSchema.parse(
                await googleJson(`${url}:pull`, token, { maxMessages: 20 }, signal, 90_000),
            );
            const emails = new Set<string>();
            for (const received of result.receivedMessages) {
                try {
                    emails.add(notificationEmail(received.message));
                } catch {
                    log.warn("Ignored malformed Pub/Sub notification", { project: projectName });
                }
            }
            await synchronize(emails);
            if (result.receivedMessages.length) {
                await googleJson(
                    `${url}:acknowledge`,
                    token,
                    { ackIds: result.receivedMessages.map((message) => message.ackId) },
                    signal,
                );
            } else {
                await delay(1000, undefined, { signal });
            }
        } catch (error) {
            if (signal.aborted) return;
            log.error("Pub/Sub poll failed", { project: projectName, error: errorMessage(error) });
            // A fixed pause prevents a tight loop when credentials or configuration are invalid
            await delay(5000, undefined, { signal }).catch(() => {});
        }
    }
}
