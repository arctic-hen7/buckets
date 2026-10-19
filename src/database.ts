import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Credentials } from "google-auth-library";
import type { Account } from "./config";

type StoredAccount = {
    email: string;
    credentials: string;
    history_id: string | null;
};

/** Only credentials, a synchronization cursor, and attempted message IDs survive restarts */
export class State {
    private readonly db: Database;

    constructor(directory = process.env.BUCKETS_STATE_DIR ?? "state") {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
        const path = resolve(directory, "buckets.sqlite");
        this.db = new Database(path, { create: true });
        chmodSync(path, 0o600);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                credentials TEXT NOT NULL,
                history_id TEXT
            );
            CREATE TABLE IF NOT EXISTS processed_messages (
                account_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                PRIMARY KEY (account_id, message_id)
            );
        `);
    }

    account(account: Account): StoredAccount | null {
        const stored = this.db
            .query<StoredAccount, [string]>(
                "SELECT email, credentials, history_id FROM accounts WHERE id = ?",
            )
            .get(account.id);
        if (stored && stored.email !== account.email) {
            throw new Error(`Account ${account.id} changed email; use a new account ID`);
        }
        return stored;
    }

    credentials(account: Account): Credentials {
        const stored = this.account(account);
        if (!stored)
            throw new Error(`Account ${account.id} needs authentication: ./auth.sh ${account.id}`);
        return JSON.parse(stored.credentials) as Credentials;
    }

    saveCredentials(account: Account, credentials: Credentials): void {
        this.account(account);
        this.db
            .query(`
                INSERT INTO accounts (id, email, credentials) VALUES (?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET credentials = excluded.credentials
            `)
            .run(account.id, account.email, JSON.stringify(credentials));
    }

    saveCursor(account: Account, historyId: string): void {
        this.db.query("UPDATE accounts SET history_id = ? WHERE id = ?").run(historyId, account.id);
    }

    /** Record before the attempt so redelivery never repeats classification, even after failure */
    claim(account: Account, messageId: string): boolean {
        return (
            this.db
                .query("INSERT OR IGNORE INTO processed_messages VALUES (?, ?)")
                .run(account.id, messageId).changes === 1
        );
    }

    close(): void {
        this.db.close();
    }
}
