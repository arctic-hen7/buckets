import type { Account, Tag } from "./config";
import type { State } from "./database";
import { type Email, type Gmail, incoming } from "./gmail";
import { GoogleHttpError } from "./google";
import { errorMessage, log } from "./logger";

type Mailbox = Pick<
    Gmail,
    "account" | "profile" | "watch" | "history" | "message" | "ensureLabels" | "applyLabels"
>;
type Classify = (email: Email, account: Account, tags: Tag[]) => Promise<string[]>;

/** Synchronization is serial per account; repeated notifications share the current pass */
export class Synchronizer {
    private running: Promise<void> | undefined;
    private ready = false;
    private watchedAt = 0;

    constructor(
        private readonly gmail: Mailbox,
        private readonly state: State,
        private readonly tags: Tag[],
        private readonly classify: Classify,
    ) {}

    sync(): Promise<void> {
        if (!this.running) {
            this.running = this.run()
                .catch((error: unknown) => {
                    log.error("Account synchronization failed", {
                        account: this.gmail.account.id,
                        error: errorMessage(error),
                    });
                })
                .finally(() => {
                    this.running = undefined;
                });
        }
        return this.running;
    }

    finish(): Promise<void> {
        return this.running ?? Promise.resolve();
    }

    private async run(): Promise<void> {
        const account = this.gmail.account;
        let cursor = this.state.account(account)?.history_id;
        if (!this.ready) {
            const profile = await this.gmail.profile();
            if (profile.emailAddress.toLowerCase() !== account.email) {
                throw new Error(`Authorized mailbox does not match ${account.email}`);
            }
            if (!cursor) {
                // Baseline before label setup so incoming mail during setup is still discovered
                cursor = profile.historyId;
                this.state.saveCursor(account, cursor);
            }
            await this.gmail.ensureLabels(this.tags.map((tag) => tag.label));
            this.ready = true;
            log.info("Account ready", { account: account.id });
        }
        if (Date.now() - this.watchedAt >= 24 * 60 * 60 * 1000) {
            this.watchedAt = Date.now();
            try {
                await this.gmail.watch();
                log.info("Mailbox watch renewed", { account: account.id });
            } catch (error) {
                log.warn("Watch renewal failed; periodic synchronization remains active", {
                    account: account.id,
                    error: errorMessage(error),
                });
            }
        }
        if (!cursor) throw new Error(`Missing history cursor for ${account.id}`);
        let pageToken: string | undefined;
        let nextCursor = cursor;
        try {
            do {
                const page = await this.gmail.history(cursor, pageToken);
                for (const event of page.history) {
                    for (const { message } of event.messagesAdded) {
                        if (!this.state.claim(account, message.id)) continue;
                        try {
                            const email = await this.gmail.message(message.id);
                            if (!incoming(email)) continue;
                            const labels = await this.classify(email, account, this.tags);
                            await this.gmail.applyLabels(message.id, labels);
                            log.info("Email classified", {
                                account: account.id,
                                message_id: message.id,
                                labels,
                            });
                        } catch (error) {
                            log.error("Email classification failed; skipped", {
                                account: account.id,
                                message_id: message.id,
                                error: errorMessage(error),
                            });
                        }
                    }
                }
                nextCursor = page.historyId;
                pageToken = page.nextPageToken;
            } while (pageToken);
            this.state.saveCursor(account, nextCursor);
        } catch (error) {
            if (!(error instanceof GoogleHttpError && error.status === 404)) throw error;
            const profile = await this.gmail.profile();
            this.state.saveCursor(account, profile.historyId);
            log.warn("Gmail history expired; resumed from current mailbox", {
                account: account.id,
            });
        }
    }
}
