import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClassifier, selectedLabels } from "../src/classifier";
import { type Account, accountTags, parseConfig } from "../src/config";
import { State } from "../src/database";
import { Gmail, incoming, readEmail, senderAddress } from "../src/gmail";
import { GoogleHttpError } from "../src/google";
import { notificationEmail } from "../src/pubsub";
import { Synchronizer } from "../src/sync";

const directories: string[] = [];
const states: State[] = [];
const account: Account = { id: "personal", email: "you@gmail.com", project: "main", aliases: [] };
const other: Account = { id: "work", email: "you@example.com", project: "main", aliases: [] };
const tag = { id: "reply", label: "Buckets/Reply", description: "A person expects a reply" };

const previousApiKey = process.env.TYPESAFE_API_KEY;

function interceptFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>) {
    return spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(handler, { preconnect() {} }),
    );
}

beforeEach(() => {
    process.env.TYPESAFE_API_KEY = "test-key";
});

function temporary(): string {
    const directory = mkdtempSync(join(tmpdir(), "buckets-test-"));
    directories.push(directory);
    return directory;
}

function database(): State {
    const state = new State(temporary());
    states.push(state);
    for (const identity of [account, other]) {
        state.saveCredentials(identity, {
            access_token: "fake",
            expiry_date: Date.now() + 3_600_000,
        });
        state.saveCursor(identity, "100");
    }
    return state;
}

function config() {
    return parseConfig({
        google: {
            main: {
                project_id: "test-project",
                oauth_client: "unused.json",
                subscriber_credentials: "unused.json",
            },
        },
        accounts: [account, other],
        tags: [tag],
    });
}

function rawMessage(id = "message-1", labelIds = ["INBOX"]) {
    return {
        id,
        labelIds,
        payload: {
            mimeType: "text/plain",
            headers: [{ name: "From", value: "Alice <alice@example.com>" }],
            body: {
                data: Buffer.from("Could you reply?\n> Quoted history stays").toString("base64url"),
            },
        },
    };
}

function mailbox() {
    return {
        account,
        profile: mock(async () => ({ emailAddress: account.email, historyId: "100" })),
        watch: mock(async () => "999"),
        ensureLabels: mock(async (_names: string[]) => {}),
        history: mock(async (_cursor: string, _pageToken?: string) => ({
            historyId: "200",
            history: [{ messagesAdded: [{ message: { id: "message-1" } }] }],
            nextPageToken: undefined as string | undefined,
        })),
        message: mock(async (id: string) => readEmail(rawMessage(id))),
        applyLabels: mock(async (_id: string, _labels: string[]) => {}),
    };
}

afterEach(() => {
    mock.restore();
    if (previousApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousApiKey;
    for (const state of states.splice(0)) state.close();
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

describe("Configuration and decisions", () => {
    test("Example TOML is valid and tag scoping works", async () => {
        const parsed = parseConfig(Bun.TOML.parse(await Bun.file("config.example.toml").text()));
        expect(parsed.threshold).toBe(0.75);
        expect(accountTags(parsed, other).map((item) => item.id)).not.toContain("alice");
    });

    test("Rejects duplicate identities, dangling references, and ambiguous tag definitions", () => {
        const input = config();
        expect(() => parseConfig({ ...input, accounts: [account, account] })).toThrow("unique");
        expect(() => parseConfig({ ...input, tags: [{ ...tag, accounts: ["unknown"] }] })).toThrow(
            "Unknown account",
        );
        expect(() =>
            parseConfig({ ...input, tags: [{ ...tag, from: ["alice@example.com"] }] }),
        ).toThrow("either");
    });

    test("Strictly exceeds the threshold, supports per-tag overrides, and allows overlap", () => {
        expect(selectedLabels([{ tag, probability: 0.75 }], 0.75)).toEqual([]);
        expect(selectedLabels([{ tag, probability: 0.7501 }], 0.75)).toEqual([tag.label]);
        expect(
            selectedLabels([{ tag: { ...tag, threshold: 0.9 }, probability: 0.85 }], 0.75),
        ).toEqual([]);
        expect(
            selectedLabels(
                [
                    { tag, probability: 0.8 },
                    { tag: { ...tag, label: "Buckets/Task" }, probability: 0.9 },
                ],
                0.75,
            ),
        ).toEqual(["Buckets/Reply", "Buckets/Task"]);
    });

    test("Exact sender tags need no network request", async () => {
        const fetch = interceptFetch(async () => {
            throw new Error("Unexpected network request");
        });
        const classify = createClassifier(config());
        expect(
            await classify(readEmail(rawMessage()), account, [
                { id: "alice", label: "Buckets/Alice", from: ["alice@example.com"] },
            ]),
        ).toEqual(["Buckets/Alice"]);
        expect(fetch).not.toHaveBeenCalled();
        expect(senderAddress('"Alice" <ALICE@example.com>')).toBe("alice@example.com");
    });
});

describe("Email input", () => {
    test("Prefers plain text, leaves quoted history intact, and ignores text attachments", () => {
        const email = readEmail({
            id: "multipart",
            payload: {
                mimeType: "multipart/mixed",
                parts: [
                    {
                        mimeType: "text/html",
                        body: { data: Buffer.from("<p>HTML</p>").toString("base64url") },
                    },
                    rawMessage().payload,
                    {
                        mimeType: "text/plain",
                        filename: "attachment.txt",
                        body: { data: Buffer.from("Attachment").toString("base64url") },
                    },
                ],
            },
        });
        expect(email.body).toBe("Could you reply?\n> Quoted history stays");
    });

    test("Raw HTML is preserved exactly", () => {
        const html =
            "<html><body><p>Hello &amp; welcome</p><blockquote>History</blockquote></body></html>";
        const email = readEmail({
            id: "html",
            payload: {
                mimeType: "text/html",
                body: { data: Buffer.from(html).toString("base64url") },
            },
        });
        expect(email.body).toBe(html);
        expect(email.mime_type).toBe("text/html");
    });

    test("Archived incoming mail is eligible; sent, draft, spam, and trash are skipped", () => {
        expect(incoming(readEmail(rawMessage("archived", [])))).toBe(true);
        for (const label of ["SENT", "DRAFT", "SPAM", "TRASH"])
            expect(incoming(readEmail(rawMessage("skip", [label])))).toBe(false);
    });

    test("Pub/Sub notifications decode and validate the account", () => {
        const data = Buffer.from(
            JSON.stringify({ emailAddress: "YOU@gmail.com", historyId: "9007199254740993" }),
        ).toString("base64");
        expect(notificationEmail({ data })).toBe(account.email);
        expect(() => notificationEmail({ data: "not-json" })).toThrow();
    });
});

describe("Once-only synchronization", () => {
    test("Deduplication is persistent and account-specific", () => {
        const state = database();
        expect(state.claim(account, "same-id")).toBe(true);
        expect(state.claim(account, "same-id")).toBe(false);
        expect(state.claim(other, "same-id")).toBe(true);
        expect(() => state.account({ ...account, email: "someone@example.com" })).toThrow(
            "new account ID",
        );
    });

    test("Pagination commits the final cursor and repeated events classify only once", async () => {
        const state = database();
        const gmail = mailbox();
        gmail.history.mockImplementation(async (_cursor, pageToken) => ({
            historyId: "200",
            history: [
                {
                    messagesAdded: [
                        { message: { id: pageToken ? "second" : "first" } },
                        { message: { id: "first" } },
                    ],
                },
            ],
            nextPageToken: pageToken ? undefined : "page-2",
        }));
        const classify = mock(async () => [tag.label]);
        const runner = new Synchronizer(gmail, state, [tag], classify);
        await runner.sync();
        expect(classify).toHaveBeenCalledTimes(2);
        expect(gmail.history).toHaveBeenNthCalledWith(1, "100", undefined);
        expect(gmail.history).toHaveBeenNthCalledWith(2, "100", "page-2");
        expect(state.account(account)?.history_id).toBe("200");
        await runner.sync();
        expect(classify).toHaveBeenCalledTimes(2);
        expect(gmail.watch).toHaveBeenCalledTimes(1);
    });

    test("Classification failure is logged, consumed, and never retried", async () => {
        const state = database();
        const gmail = mailbox();
        const classify = mock(async () => {
            throw new Error("Jev unavailable");
        });
        const logger = spyOn(console, "log").mockImplementation(() => {});
        const runner = new Synchronizer(gmail, state, [tag], classify);
        await runner.sync();
        await runner.sync();
        expect(classify).toHaveBeenCalledTimes(1);
        expect(gmail.applyLabels).not.toHaveBeenCalled();
        expect(state.account(account)?.history_id).toBe("200");
        expect(
            logger.mock.calls.some(([line]) =>
                String(line).includes("Email classification failed; skipped"),
            ),
        ).toBe(true);
    });

    test("Expired history resets without replaying old messages", async () => {
        const state = database();
        const gmail = mailbox();
        gmail.history.mockImplementation(async () => {
            throw new GoogleHttpError(404, "history");
        });
        gmail.profile.mockResolvedValue({ emailAddress: account.email, historyId: "300" });
        const classify = mock(async () => []);
        await new Synchronizer(gmail, state, [tag], classify).sync();
        expect(state.account(account)?.history_id).toBe("300");
        expect(classify).not.toHaveBeenCalled();
    });

    test("Watch failure still allows periodic history synchronization", async () => {
        const state = database();
        const gmail = mailbox();
        gmail.watch.mockImplementation(async () => {
            throw new GoogleHttpError(403, "watch");
        });
        const classify = mock(async () => [tag.label]);
        await new Synchronizer(gmail, state, [tag], classify).sync();
        expect(classify).toHaveBeenCalledTimes(1);
    });

    test("Concurrent notifications share one synchronization pass", async () => {
        const state = database();
        const gmail = mailbox();
        const classify = mock(async () => [tag.label]);
        const runner = new Synchronizer(gmail, state, [tag], classify);
        await Promise.all([runner.sync(), runner.sync(), runner.sync()]);
        expect(gmail.history).toHaveBeenCalledTimes(1);
        expect(classify).toHaveBeenCalledTimes(1);
    });
});

test("Gmail → Jev → labels uses the real adapters with mocked HTTP", async () => {
    const state = database();
    const configured = config();
    const project = configured.google.main;
    if (!project) throw new Error("Missing test project");
    project.oauth_client = join(temporary(), "oauth.json");
    await Bun.write(
        project.oauth_client,
        JSON.stringify({
            installed: { client_id: "fake", client_secret: "fake", project_id: project.project_id },
        }),
    );
    const writes: unknown[] = [];
    let jevCalls = 0;
    interceptFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/profile"))
            return Response.json({ emailAddress: account.email, historyId: "100" });
        if (url.endsWith("/watch")) return Response.json({ historyId: "999" });
        if (url.endsWith("/labels"))
            return Response.json({ labels: [{ id: "Label_reply", name: tag.label }] });
        if (url.includes("/history?"))
            return Response.json({
                historyId: "200",
                history: [{ messagesAdded: [{ message: { id: "message-1" } }] }],
            });
        if (url.includes("/messages/message-1?")) return Response.json(rawMessage());
        if (url === "https://api.typesafe.ai/v1/systemone") {
            jevCalls++;
            const request = JSON.parse(String(init?.body));
            expect(request.state.body).toContain("> Quoted history stays");
            expect(request.questions.reply.type).toBe("noul");
            return Response.json({
                model: "test-model",
                answers: { reply: { type: "noul", noul: 0.9 } },
                usage: { input_tokens: 10, output_tokens: 1 },
            });
        }
        if (url.endsWith("/messages/message-1/modify")) {
            writes.push(JSON.parse(String(init?.body)));
            return Response.json({ id: "message-1" });
        }
        throw new Error(`Unexpected request ${url}`);
    });
    const runner = new Synchronizer(
        new Gmail(account, project, state),
        state,
        [tag],
        createClassifier(configured),
    );
    await runner.sync();
    await runner.sync();
    expect(jevCalls).toBe(1);
    expect(writes).toEqual([{ addLabelIds: ["Label_reply"] }]);
    expect(state.account(account)?.history_id).toBe("200");
});
