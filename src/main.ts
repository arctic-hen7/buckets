import { createClassifier } from "./classifier";
import { accountTags, loadConfig } from "./config";
import { State } from "./database";
import { Gmail } from "./gmail";
import { oauthClient } from "./google";
import { errorMessage, log } from "./logger";
import { listen } from "./pubsub";
import { Synchronizer } from "./sync";

async function main(): Promise<void> {
    const config = await loadConfig();
    for (const project of Object.values(config.google)) {
        await oauthClient(project);
        if (!(await Bun.file(project.subscriber_credentials).exists())) {
            throw new Error(`Missing subscriber credentials: ${project.subscriber_credentials}`);
        }
    }
    if (Bun.argv.includes("--check")) {
        log.info("Configuration and credential files are valid", {
            accounts: config.accounts.length,
        });
        return;
    }
    const classify = createClassifier(config);
    const state = new State();
    const shutdown = new AbortController();
    const runners = config.accounts.map((account) => {
        const project = config.google[account.project];
        if (!project) throw new Error(`Unknown project ${account.project}`);
        return {
            account,
            sync: new Synchronizer(
                new Gmail(account, project, state),
                state,
                accountTags(config, account),
                classify,
            ),
        };
    });
    const synchronizeAll = () => Promise.all(runners.map(({ sync }) => sync.sync()));
    const catchUp = setInterval(() => void synchronizeAll(), 5 * 60 * 1000);
    function stop(): void {
        log.info("Stopping Buckets");
        clearInterval(catchUp);
        shutdown.abort();
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        await synchronizeAll();
        log.info("Buckets started", { accounts: runners.length, threshold: config.threshold });
        const usedProjects = new Set(config.accounts.map((account) => account.project));
        await Promise.all(
            [...usedProjects].map(async (name) => {
                const project = config.google[name];
                if (!project) return;
                await listen(
                    name,
                    project,
                    async (emails) => {
                        await Promise.all(
                            runners
                                .filter(
                                    ({ account }) =>
                                        account.project === name && emails.has(account.email),
                                )
                                .map(({ sync }) => sync.sync()),
                        );
                    },
                    shutdown.signal,
                );
            }),
        );
    } finally {
        clearInterval(catchUp);
        await Promise.all(runners.map(({ sync }) => sync.finish()));
        state.close();
    }
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        log.error("Cannot start Buckets", { error: errorMessage(error) });
        process.exitCode = 1;
    });
}
