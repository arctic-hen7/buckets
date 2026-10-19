import { z } from "zod";
import type { Account, Project } from "./config";
import type { State } from "./database";
import { googleJson, mailboxClient } from "./google";

type Header = { name: string; value: string };
type Part = {
    mimeType: string;
    filename: string;
    headers: Header[];
    body: { data: string };
    parts: Part[];
};

const partSchema: z.ZodType<Part> = z.lazy(() =>
    z.object({
        mimeType: z.string().default(""),
        filename: z.string().default(""),
        headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
        body: z.object({ data: z.string().default("") }).default({ data: "" }),
        parts: z.array(partSchema).default([]),
    }),
);

const messageSchema = z.object({
    id: z.string(),
    labelIds: z.array(z.string()).default([]),
    snippet: z.string().default(""),
    payload: partSchema,
});
const cursorSchema = z.object({ historyId: z.string().regex(/^\d+$/) });
const historySchema = cursorSchema.extend({
    nextPageToken: z.string().optional(),
    history: z
        .array(
            z.object({
                messagesAdded: z
                    .array(z.object({ message: z.object({ id: z.string() }) }))
                    .default([]),
            }),
        )
        .default([]),
});
const labelsSchema = z.object({
    labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});

export type Email = {
    id: string;
    labels: string[];
    headers: Record<string, string>;
    body: string;
    mime_type: string;
};

/** Decode the transport only; HTML and quoted history go to Jev unchanged */
export function readEmail(input: unknown): Email {
    const message = messageSchema.parse(input);
    const plain: string[] = [];
    const html: string[] = [];
    function visit(part: Part): void {
        if (part.filename) return;
        const text = Buffer.from(part.body.data, "base64url").toString("utf8");
        if (text && part.mimeType === "text/plain") plain.push(text);
        if (text && part.mimeType === "text/html") html.push(text);
        for (const child of part.parts) visit(child);
    }
    visit(message.payload);
    const headers = Object.fromEntries(
        message.payload.headers.map(({ name, value }) => [name.toLowerCase(), value]),
    );
    return {
        id: message.id,
        labels: message.labelIds,
        headers,
        body: (plain.length ? plain : html).join("\n\n") || message.snippet,
        mime_type: plain.length ? "text/plain" : html.length ? "text/html" : "text/plain",
    };
}

export function incoming(email: Email): boolean {
    return !email.labels.some((label) => ["SENT", "DRAFT", "SPAM", "TRASH"].includes(label));
}

export function senderAddress(from: string): string {
    return (from.match(/<([^<>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

export class Gmail {
    private readonly labels = new Map<string, string>();

    constructor(
        readonly account: Account,
        private readonly project: Project,
        private readonly state: State,
    ) {}

    private async request(path: string, body?: unknown): Promise<unknown> {
        // Reload credentials so auth.sh can reauthorize an account without restarting the service
        const client = await mailboxClient(this.account, this.project, this.state);
        const { token } = await client.getAccessToken();
        if (!token) throw new Error(`No access token for ${this.account.id}`);
        return googleJson(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, token, body);
    }

    async profile(): Promise<{ emailAddress: string; historyId: string }> {
        return cursorSchema
            .extend({ emailAddress: z.email() })
            .parse(await this.request("profile"));
    }

    async watch(): Promise<string> {
        return cursorSchema.parse(
            await this.request("watch", {
                topicName: `projects/${this.project.project_id}/topics/${this.project.topic}`,
            }),
        ).historyId;
    }

    async history(cursor: string, pageToken?: string): Promise<z.infer<typeof historySchema>> {
        const query = new URLSearchParams({
            startHistoryId: cursor,
            historyTypes: "messageAdded",
            maxResults: "500",
        });
        if (pageToken) query.set("pageToken", pageToken);
        return historySchema.parse(await this.request(`history?${query}`));
    }

    async message(id: string): Promise<Email> {
        return readEmail(await this.request(`messages/${encodeURIComponent(id)}?format=full`));
    }

    async ensureLabels(names: string[]): Promise<void> {
        const existing = labelsSchema.parse(await this.request("labels"));
        this.labels.clear();
        for (const label of existing.labels) this.labels.set(label.name, label.id);
        for (const name of names) {
            if (this.labels.has(name)) continue;
            const label = z.object({ id: z.string() }).parse(
                await this.request("labels", {
                    name,
                    labelListVisibility: "labelShow",
                    messageListVisibility: "show",
                }),
            );
            this.labels.set(name, label.id);
        }
    }

    async applyLabels(messageId: string, names: string[]): Promise<void> {
        if (!names.length) return;
        const addLabelIds = names.map((name) => {
            const id = this.labels.get(name);
            if (!id) throw new Error(`Label ${name} is missing; restart to reload labels`);
            return id;
        });
        await this.request(`messages/${encodeURIComponent(messageId)}/modify`, { addLabelIds });
    }
}
