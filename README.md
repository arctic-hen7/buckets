# Buckets

Buckets tags incoming Gmail messages using natural-language rules and Jev. It
runs as one Bun/TypeScript process with SQLite and a rootless Podman deployment.
Multiple accounts can share rules or have their own tags and Google projects.

For every new email, Buckets uses plain text if available, otherwise raw HTML,
including quoted history. It asks Jev one yes/no question per semantic tag in a
single request and applies labels with probabilities **greater than** `0.75`
by default. Exact sender rules are matched locally. Tags can overlap.

Messages are attempted once. Afterwards, labels are yours to change. Buckets
never sends mail, archives messages, clears action labels, or creates tasks.
Failures are logged and skipped.
classification retry.

## Requirements

- A Linux VPS or local machine with rootless Podman and `podman-compose`
- A TypeSafe API key for Jev
- Google Cloud access to create an OAuth client, Pub/Sub resources, and a service
  account key
- A browser for authorizing each Gmail account
- SSH access when authorizing on a remote VPS

For development instead of containers, use Bun **1.4.2 or newer**.

## 1. Create the local configuration

```bash
cp config.example.toml config.toml
cp .env.example .env
mkdir -p google state
chmod 700 google state
chmod 600 .env config.toml
```

Set `TYPESAFE_API_KEY` in `.env` or export it in the shell used by `deploy.sh`.
Edit `config.toml` to set your accounts, rules, and Google project. Remove example
accounts and tags you do not want. Each account ID is a stable local name such
as `personal` or `work`; do not reuse an authenticated ID for a different email.

The application's configuration is TOML. Google supplies its downloaded
credentials as JSON files; those remain unchanged in the ignored `google/`
directory. Runtime credentials and cursors live in the ignored `state/`
directory. None of these files belongs in Git or the container image.

## 2. Set up Google Cloud

Use one project for all accounts when they can authorize the same OAuth client.
An **External** OAuth audience supports personal Gmail accounts and Workspace
accounts whose administrators permit it. An **Internal** client is restricted
to its Workspace organization. Separate projects are supported when accounts
need different audiences; see the multi-account section below.

### OAuth client

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Create or select a project and copy its **project ID** into
   `google.main.project_id` in `config.toml`.
2. Under **APIs & Services → Library**, enable **Gmail API** and **Cloud Pub/Sub
   API**.
3. Open **Google Auth Platform** and configure the app name, support email, and
   developer contact email. Choose **External** for personal Gmail accounts or
   **Internal** for accounts in your Workspace organization.
4. For an External app in Testing, add **each account** under **Audience → Test
   users**.
5. Under **Clients**, create a **Desktop app** OAuth client named `Buckets`.
6. Download the client JSON to `google/main-oauth.json`. A Desktop client needs
   no manually registered redirect URI. Buckets uses a temporary loopback
   callback with PKCE.

Buckets requests `gmail.modify` because applying labels to messages requires
that scope. Google offers no body-read-and-label-only scope; the application
only implements reads, watches, label creation, and label additions. Approve
Gmail access when connecting each account.

External apps in **Testing** receive refresh tokens that expire after seven
days. For unattended use, move the app to **In production**, then authenticate
again. Production publishing does not itself complete OAuth verification.
Personal-use apps can qualify for Google's verification exceptions; Workspace
admins can still restrict authorization. See Google's
[token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
and [personal-use verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### Pub/Sub

These resources provide notifications, independently of account OAuth tokens:

| Resource | Configuration |
| --- | --- |
| Topic | `buckets-gmail` in the OAuth client's Google project |
| Topic publisher | `gmail-api-push@system.gserviceaccount.com`, role **Pub/Sub Publisher** on the topic |
| Subscription | `buckets-gmail`, **Pull**, 300-second acknowledgement deadline, no expiration |
| Subscriber service account | `buckets-subscriber`, role **Pub/Sub Subscriber** on the subscription |
| Subscriber key | Download a JSON key to `google/main-subscriber.json` |

You can create these in **Pub/Sub** and **IAM & Admin → Service Accounts** in the
console. Grant the subscriber role through the subscription's Permissions
panel; it does not need project Editor, Gmail permissions, or domain-wide
delegation. In the service account's **Keys** tab, choose **Add key → Create new
key → JSON**. Your organization's policy must permit creating this key.

Alternatively, with the Google Cloud CLI authenticated as a project owner or
suitably authorized administrator, run the following once. The OAuth client
still needs to be created in the console.

```bash
CLOUD_PROJECT="your-google-project"
SUBSCRIBER_EMAIL="buckets-subscriber@${CLOUD_PROJECT}.iam.gserviceaccount.com"

gcloud services enable gmail.googleapis.com pubsub.googleapis.com --project "$CLOUD_PROJECT"
gcloud pubsub topics create buckets-gmail --project "$CLOUD_PROJECT"
gcloud pubsub topics add-iam-policy-binding buckets-gmail \
    --project "$CLOUD_PROJECT" \
    --member "serviceAccount:gmail-api-push@system.gserviceaccount.com" \
    --role roles/pubsub.publisher
gcloud pubsub subscriptions create buckets-gmail \
    --project "$CLOUD_PROJECT" \
    --topic buckets-gmail \
    --ack-deadline 300 \
    --expiration-period never
gcloud iam service-accounts create buckets-subscriber --project "$CLOUD_PROJECT"
gcloud pubsub subscriptions add-iam-policy-binding buckets-gmail \
    --project "$CLOUD_PROJECT" \
    --member "serviceAccount:${SUBSCRIBER_EMAIL}" \
    --role roles/pubsub.subscriber
gcloud iam service-accounts keys create google/main-subscriber.json \
    --project "$CLOUD_PROJECT" \
    --iam-account "$SUBSCRIBER_EMAIL"
```

Make the downloaded credential files private:

```bash
chmod 600 google/*.json
```

The Pub/Sub topic must belong to the OAuth client's project. Gmail watches
publish to that topic, and Buckets consumes its subscription through outbound
long polling. No domain, public webhook, or reverse proxy is needed.
[Gmail's push setup](https://developers.google.com/workspace/gmail/api/guides/push)
describes this integration.

## 3. Connect every account

For a VPS, open an SSH connection **from the computer with your browser**:

```bash
ssh -L 8787:127.0.0.1:8787 your-user@your-vps
```

In that server shell, enter the Buckets directory and run:

```bash
./auth.sh personal
./auth.sh work
```

Run accounts sequentially. Open each printed URL in the browser on your
computer, choose the expected Google account, and approve access. The redirect
to `127.0.0.1:8787` goes through SSH to the temporary callback container. The
browser confirms success and the command exits. On a local machine, use the
same commands without SSH forwarding.

`auth.sh` builds the image and shares its state mount with the service. It can
run before deployment or while Buckets is already running. Each account's
identity and granted scope are checked before credentials are saved. New
accounts begin at the mailbox position captured during login; existing mail is
not backfilled. Reauthorization preserves an existing cursor.

If port 8787 is occupied, forward another port and use it in both places:

```bash
ssh -L 8788:127.0.0.1:8788 your-user@your-vps
BUCKETS_AUTH_PORT=8788 ./auth.sh personal
```

### Multiple accounts and projects

Accounts have independent tokens and cursors even when they share a project.
Simply add another `[[accounts]]` entry, authorize its ID, and redeploy.

When a work account requires a separate OAuth audience, repeat Google setup in
another project and add a profile:

```toml
[google.work]
project_id = "your-work-project"
oauth_client = "google/work-oauth.json"
subscriber_credentials = "google/work-subscriber.json"
```

Then set the work account's `project = "work"`. The omitted topic and
subscription names both default to `buckets-gmail`. Each configured project
gets its own pull loop. Each account must authorize a client whose audience
permits that account.

## 4. Deploy

```bash
./deploy.sh
podman-compose logs -f buckets
```

Deployment validates TOML and credential paths, builds the pinned image, and
starts the service. It preserves state, discovers your UID/GID, and runs with
rootless Podman, a read-only filesystem, and no published ports. Only the
temporary authentication container publishes a host-loopback port.

Look for `Account ready`, `Mailbox watch renewed`, and `Buckets started`. Send
yourself a new email from a different account and watch for `Email classified`
with its label names. Accounts that need reauthorization log a synchronization
failure while other accounts continue. Fix the account with `./auth.sh ID`;
the next notification or five-minute check reads the new credentials.

Useful operations:

```bash
podman-compose ps
podman-compose logs -f buckets
podman-compose restart buckets
podman-compose down
```

Run `deploy.sh` after changing configuration or code. If running Compose
directly under a UID other than 1000, export `HOST_UID` and `HOST_GID` first;
the scripts do this automatically.

## Tags and behavior

Define one focused condition per tag in natural language. Specify exclusions
in the description when useful. Give each tag a unique ID and a unique label
under `Buckets/`. Gmail labels are created automatically.

```toml
[[tags]]
id = "invoice"
label = "Buckets/Invoices"
description = "An invoice or payment request addressed to me, excluding advertisements"
accounts = ["work"]
threshold = 0.8
```

Omit `accounts` to apply a tag to every account. Omit `threshold` to use the
global threshold. A probability exactly equal to the threshold does **not**
apply the label. Setting the threshold to `1` disables matching for that tag.

For exact sender matching, use `from` instead of `description`:

```toml
[[tags]]
id = "alice"
label = "Buckets/People/Alice"
from = ["alice@example.com", "alice@company.com"]
```

Sender matches have probabilities 1 or 0 and use the same threshold rule. Each
incoming email receives all matching labels. Jev only receives that message's
headers and available body, plus the recipient account and aliases. There is
no thread fetch, HTML conversion, quotation stripping, attachment download,
or generated explanation. If the body is unavailable, Gmail's snippet is used.

All newly added incoming messages are eligible, including automatically
archived mail. Sent messages, drafts, spam, and trash are skipped. Gmail
conversation views may show a label belonging to one message in the thread;
Buckets labels the individual received message.

The database records each message ID **before** attempting classification.
Duplicates, subsequent label changes, and rule edits never reclassify it.
Fetch, Jev, or label-write failures are logged and left alone; a crash after
recording an ID can also leave that message unclassified. No bodies or
probabilities are stored. Jev's automatic request retries are disabled.

Watches renew daily, and five-minute history checks catch missed notifications.
If the saved Gmail history expires, Buckets logs the gap and resumes from the
current mailbox. It does not recover old mail. Pub/Sub errors get a fixed
five-second pause before the next poll; there is no retry scheduler.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Access blocked during login | Add the account as an External test user; check Workspace administrator restrictions |
| Login works, then expires after a week | Move the External OAuth app out of Testing and authorize again |
| Browser cannot reach the callback | Keep the SSH forward open; use the same callback port on both sides |
| OAuth client file rejected | Download a **Desktop app** client from the configured project |
| Watch HTTP 400/403/404 | Check the topic name, OAuth project, Gmail API enablement, and Gmail publisher permission |
| Pub/Sub HTTP 403/404 | Check subscription name, service-account key, subscriber role, and API enablement |
| Jev HTTP 401/429 | Check API key and available API quota; the affected message is skipped |
| Labels disappeared or were renamed | Restart to refresh label mappings and recreate configured labels |
| State permission denied | Run scripts as the deployment user; use `keep-id` and host-owned bind mounts |

## Development

```bash
bun install --frozen-lockfile
bun run auth personal
bun run src/main.ts --check
bun start
```

Local Bun automatically reads `.env`. `BUCKETS_CONFIG` overrides the TOML path,
and `BUCKETS_STATE_DIR` overrides the state directory. Credential paths are
resolved relative to the TOML file. `BUCKETS_AUTH_PORT` changes the login port.

```bash
bun run check
bun test
bun run format
```

The small modules separate configuration, OAuth, Gmail, Pub/Sub, classification,
and synchronization. SQLite has just `accounts` and `processed_messages`.
Tests exercise threshold behavior, body selection, deduplication, account
isolation, synchronization pagination, and failure handling without live email
or paid API calls.
