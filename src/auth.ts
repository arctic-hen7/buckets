import { randomBytes, timingSafeEqual } from "node:crypto";
import { CodeChallengeMethod } from "google-auth-library";
import { z } from "zod";
import { loadConfig } from "./config";
import { State } from "./database";
import { GMAIL_SCOPE, googleJson, oauthClient } from "./google";
import { errorMessage, log } from "./logger";

/** Authenticate one account through a loopback callback, optionally forwarded over SSH */
export async function authenticate(accountId: string): Promise<void> {
    const config = await loadConfig();
    const account = config.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error(`Unknown account ${accountId}`);
    const project = config.google[account.project];
    if (!project) throw new Error(`Unknown project ${account.project}`);
    const port = Number(process.env.BUCKETS_AUTH_PORT ?? "8787");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Invalid BUCKETS_AUTH_PORT");
    const client = await oauthClient(project, `http://127.0.0.1:${port}/callback`);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    if (!codeChallenge) throw new Error("Could not generate OAuth PKCE challenge");
    const nonce = randomBytes(24).toString("hex");
    const state = new State();
    state.account(account);
    let used = false;
    const completion = Promise.withResolvers<void>();
    const server = Bun.serve({
        hostname: process.env.BUCKETS_AUTH_HOST ?? "127.0.0.1",
        port,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
            const suppliedState = Buffer.from(url.searchParams.get("state") ?? "");
            const expectedState = Buffer.from(nonce);
            if (
                suppliedState.length !== expectedState.length ||
                !timingSafeEqual(suppliedState, expectedState)
            ) {
                return new Response("Invalid OAuth state", { status: 400 });
            }
            if (used) return new Response("Login already handled", { status: 409 });
            used = true;
            try {
                if (url.searchParams.has("error"))
                    throw new Error("Google authorization was declined");
                const code = url.searchParams.get("code");
                if (!code) throw new Error("Google did not return an authorization code");
                const { tokens } = await client.getToken({ code, codeVerifier });
                if (!tokens.refresh_token || !tokens.access_token) {
                    throw new Error(
                        "Google did not grant offline access; run authentication again",
                    );
                }
                if (!tokens.scope?.split(" ").includes(GMAIL_SCOPE)) {
                    throw new Error("Gmail modify permission was not granted");
                }
                const profile = z
                    .object({ emailAddress: z.email(), historyId: z.string().regex(/^\d+$/) })
                    .parse(
                        await googleJson(
                            "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                            tokens.access_token,
                        ),
                    );
                if (profile.emailAddress.toLowerCase() !== account.email) {
                    throw new Error(`Wrong Google account; authorize ${account.email}`);
                }
                const previous = state.account(account);
                state.saveCredentials(account, tokens);
                if (!previous?.history_id) state.saveCursor(account, profile.historyId);
                log.info("Account authenticated", { account: account.id, email: account.email });
                completion.resolve();
                return new Response("Buckets account connected. You can close this tab.");
            } catch (error) {
                completion.reject(error);
                return new Response(
                    "Authentication failed. Check the terminal and run auth.sh again.",
                    {
                        status: 400,
                    },
                );
            }
        },
    });
    const timeout = setTimeout(
        () => completion.reject(new Error("Login timed out after 10 minutes")),
        600_000,
    );
    const stop = () => completion.reject(new Error("Login cancelled"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`\nAuthorize ${account.email} by opening this URL:\n`);
    console.log(
        client.generateAuthUrl({
            access_type: "offline",
            prompt: "consent select_account",
            scope: [GMAIL_SCOPE],
            login_hint: account.email,
            state: nonce,
            code_challenge: codeChallenge,
            code_challenge_method: CodeChallengeMethod.S256,
        }),
    );
    console.log(`\nOn a VPS, first forward port ${port} as described in README.md.\n`);
    try {
        await completion.promise;
    } finally {
        clearTimeout(timeout);
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await server.stop();
        state.close();
    }
}

if (import.meta.main) {
    const accountId = Bun.argv[2];
    if (!accountId) {
        console.error("Usage: bun run auth <account-id>");
        process.exitCode = 1;
    } else {
        authenticate(accountId).catch((error: unknown) => {
            log.error("Authentication failed", { error: errorMessage(error) });
            process.exitCode = 1;
        });
    }
}
