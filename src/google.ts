import { type Credentials, GoogleAuth, OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { Account, Project } from "./config";
import type { State } from "./database";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const oauthSchema = z.object({
    installed: z.object({
        client_id: z.string().min(1),
        client_secret: z.string().min(1),
        project_id: z.string().min(1),
    }),
});

export async function oauthClient(project: Project, redirectUri?: string): Promise<OAuth2Client> {
    const { installed } = oauthSchema.parse(await Bun.file(project.oauth_client).json());
    if (installed.project_id !== project.project_id) {
        throw new Error(
            `OAuth client belongs to ${installed.project_id}, not ${project.project_id}`,
        );
    }
    return new OAuth2Client({
        clientId: installed.client_id,
        clientSecret: installed.client_secret,
        transporterOptions: { fetchImplementation: fetch, timeout: 30_000 },
        ...(redirectUri ? { redirectUri } : {}),
    });
}

export async function mailboxClient(
    account: Account,
    project: Project,
    state: State,
): Promise<OAuth2Client> {
    const client = await oauthClient(project);
    client.setCredentials(state.credentials(account));
    client.on("tokens", (tokens: Credentials) => {
        state.saveCredentials(account, { ...state.credentials(account), ...tokens });
    });
    return client;
}

export function subscriberClient(project: Project): GoogleAuth {
    return new GoogleAuth({
        keyFile: project.subscriber_credentials,
        scopes: ["https://www.googleapis.com/auth/pubsub"],
        clientOptions: { transporterOptions: { fetchImplementation: fetch, timeout: 30_000 } },
    });
}

export class GoogleHttpError extends Error {
    constructor(
        readonly status: number,
        operation: string,
    ) {
        super(`${operation}: Google HTTP ${status}`);
    }
}

/** Call Google once and avoid including potentially private response bodies in errors */
export async function googleJson(
    url: string,
    token: string,
    body?: unknown,
    signal?: AbortSignal,
    timeout = 30_000,
): Promise<unknown> {
    const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new GoogleHttpError(response.status, new URL(url).pathname);
    }
    return response.json();
}
