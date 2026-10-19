import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticate } from "../src/auth";
import type { Account, Project } from "../src/config";
import { State } from "../src/database";
import { GMAIL_SCOPE } from "../src/google";
import { listen } from "../src/pubsub";

const directories: string[] = [];
const previousEnvironment = {
    BUCKETS_CONFIG: process.env.BUCKETS_CONFIG,
    BUCKETS_STATE_DIR: process.env.BUCKETS_STATE_DIR,
    BUCKETS_AUTH_PORT: process.env.BUCKETS_AUTH_PORT,
};

function temporary(): string {
    const directory = mkdtempSync(join(tmpdir(), "buckets-google-"));
    directories.push(directory);
    return directory;
}

function interceptFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>) {
    return spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(handler, { preconnect() {} }),
    );
}

afterEach(() => {
    mock.restore();
    for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

for (const outcome of ["connected", "wrong account", "missing scope"] as const) {
    test(`OAuth callback: ${outcome}`, async () => {
        const directory = temporary();
        await Bun.write(
            join(directory, "oauth.json"),
            JSON.stringify({
                installed: { client_id: "fake", client_secret: "fake", project_id: "test-project" },
            }),
        );
        await Bun.write(
            join(directory, "config.toml"),
            `
            [google.main]
            project_id = "test-project"
            oauth_client = "oauth.json"
            subscriber_credentials = "unused.json"
            [[accounts]]
            id = "personal"
            email = "you@gmail.com"
            project = "main"
            [[tags]]
            id = "reply"
            label = "Buckets/Reply"
            description = "Needs a reply"
        `,
        );
        const probe = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = probe.port;
        await probe.stop();
        process.env.BUCKETS_CONFIG = join(directory, "config.toml");
        process.env.BUCKETS_STATE_DIR = join(directory, "state");
        process.env.BUCKETS_AUTH_PORT = String(port);
        const realFetch = globalThis.fetch;
        interceptFetch(async (input, init) => {
            const url = String(input);
            if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
            if (url === "https://oauth2.googleapis.com/token") {
                const body = new URLSearchParams(String(init?.body));
                expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
                return Response.json({
                    access_token: "fake-access",
                    refresh_token: "fake-refresh",
                    expires_in: 3600,
                    scope: outcome === "missing scope" ? "openid" : GMAIL_SCOPE,
                });
            }
            if (url.endsWith("/profile"))
                return Response.json({
                    emailAddress: outcome === "wrong account" ? "other@gmail.com" : "you@gmail.com",
                    historyId: "200",
                });
            throw new Error(`Unexpected OAuth request ${url}`);
        });
        let callback: Promise<Response> | undefined;
        spyOn(console, "log").mockImplementation((line: unknown) => {
            if (!String(line).startsWith("https://accounts.google.com/")) return;
            const authorization = new URL(String(line));
            expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
            const url = new URL(`http://127.0.0.1:${port}/callback`);
            url.searchParams.set("state", authorization.searchParams.get("state") ?? "");
            url.searchParams.set("code", "fake-code");
            callback = realFetch(url);
        });
        if (outcome === "connected") {
            await authenticate("personal");
            expect((await callback)?.status).toBe(200);
        } else {
            await expect(authenticate("personal")).rejects.toThrow(
                outcome === "wrong account" ? "Wrong Google account" : "permission was not granted",
            );
            expect((await callback)?.status).toBe(400);
        }
        const state = new State(join(directory, "state"));
        const account: Account = {
            id: "personal",
            email: "you@gmail.com",
            project: "main",
            aliases: [],
        };
        try {
            if (outcome === "connected") {
                expect(state.account(account)?.history_id).toBe("200");
                expect(state.credentials(account).refresh_token).toBe("fake-refresh");
            } else expect(state.account(account)).toBeNull();
        } finally {
            state.close();
        }
    });
}

test("Pub/Sub pull uses service-account auth, coalesces notifications, and acknowledges them", async () => {
    const directory = temporary();
    const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const project: Project = {
        project_id: "test-project",
        oauth_client: "unused.json",
        subscriber_credentials: join(directory, "subscriber.json"),
        topic: "buckets-gmail",
        subscription: "buckets-gmail",
    };
    await Bun.write(
        project.subscriber_credentials,
        JSON.stringify({
            type: "service_account",
            project_id: project.project_id,
            private_key: privateKey,
            client_email: "test@test-project.iam.gserviceaccount.com",
        }),
    );
    const shutdown = new AbortController();
    const data = Buffer.from(
        JSON.stringify({ emailAddress: "you@gmail.com", historyId: "100" }),
    ).toString("base64");
    const acknowledged: unknown[] = [];
    interceptFetch(async (input, init) => {
        const url = String(input);
        if (url.includes("/token"))
            return Response.json({
                access_token: "fake-access",
                expires_in: 3600,
                token_type: "Bearer",
            });
        if (url.endsWith(":pull"))
            return Response.json({
                receivedMessages: [
                    { ackId: "one", message: { data } },
                    { ackId: "two", message: { data } },
                    { ackId: "malformed", message: { data: "invalid" } },
                ],
            });
        if (url.endsWith(":acknowledge")) {
            acknowledged.push(JSON.parse(String(init?.body)));
            shutdown.abort();
            return Response.json({});
        }
        throw new Error(`Unexpected Pub/Sub request ${url}`);
    });
    const synchronize = mock(async (_emails: Set<string>) => {});
    await listen("main", project, synchronize, shutdown.signal);
    expect(synchronize).toHaveBeenCalledWith(new Set(["you@gmail.com"]));
    expect(acknowledged).toEqual([{ ackIds: ["one", "two", "malformed"] }]);
});
