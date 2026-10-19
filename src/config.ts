import { dirname, resolve } from "node:path";
import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
const email = z.email().transform((value) => value.toLowerCase());
const probability = z.number().min(0).max(1);

const projectSchema = z.strictObject({
    project_id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    oauth_client: z.string().min(1),
    subscriber_credentials: z.string().min(1),
    topic: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9._~+%-]*$/)
        .default("buckets-gmail"),
    subscription: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9._~+%-]*$/)
        .default("buckets-gmail"),
});

const accountSchema = z.strictObject({
    id: identifier,
    email,
    project: identifier,
    aliases: z.array(email).default([]),
});

const tagSchema = z
    .strictObject({
        id: identifier,
        label: z.string().startsWith("Buckets/").min(9),
        description: z.string().trim().min(1).optional(),
        from: z.array(email).min(1).optional(),
        accounts: z.array(identifier).min(1).optional(),
        threshold: probability.optional(),
    })
    .refine((tag) => Boolean(tag.description) !== Boolean(tag.from), {
        message: "Each tag needs either description or from, but not both",
    });

const configSchema = z.strictObject({
    threshold: probability.default(0.75),
    model: z.string().min(1).default("jev-latest"),
    google: z.record(identifier, projectSchema),
    accounts: z.array(accountSchema).min(1),
    tags: z.array(tagSchema).min(1),
});

export type Config = z.infer<typeof configSchema>;
export type Account = Config["accounts"][number];
export type Tag = Config["tags"][number];
export type Project = Config["google"][string];

/** Validate references here so setup errors are caught before contacting Google */
export function parseConfig(input: unknown): Config {
    const config = configSchema.parse(input);
    const accountIds = new Set(config.accounts.map((account) => account.id));
    if (accountIds.size !== config.accounts.length) throw new Error("Account IDs must be unique");
    if (new Set(config.accounts.map((account) => account.email)).size !== config.accounts.length) {
        throw new Error("Account email addresses must be unique");
    }
    for (const account of config.accounts) {
        if (!config.google[account.project]) {
            throw new Error(`Unknown Google project ${account.project} for ${account.id}`);
        }
    }
    for (const field of ["id", "label"] as const) {
        if (new Set(config.tags.map((tag) => tag[field])).size !== config.tags.length) {
            throw new Error(`Tag ${field}s must be unique`);
        }
    }
    for (const tag of config.tags) {
        for (const accountId of tag.accounts ?? []) {
            if (!accountIds.has(accountId))
                throw new Error(`Unknown account ${accountId} in ${tag.id}`);
        }
    }
    return config;
}

export async function loadConfig(): Promise<Config> {
    const path = resolve(process.env.BUCKETS_CONFIG ?? "config.toml");
    const config = parseConfig(Bun.TOML.parse(await Bun.file(path).text()));
    for (const project of Object.values(config.google)) {
        project.oauth_client = resolve(dirname(path), project.oauth_client);
        project.subscriber_credentials = resolve(dirname(path), project.subscriber_credentials);
    }
    return config;
}

export function accountTags(config: Config, account: Account): Tag[] {
    return config.tags.filter((tag) => !tag.accounts || tag.accounts.includes(account.id));
}
