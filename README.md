# db-audit

db-audit is a small web app that you run on your own computer. You point it at a **SQL Server**, **Azure SQL Database** or **Azure SQL Managed Instance** database, and it shows you what is inside: the tables, the code, how everything is connected, and the scheduled jobs that run against it.

It only ever **reads** from your database. It never changes anything there.

What you can do with it:

- **Browse everything in one place.** Tables (with columns, indexes, foreign keys and row counts), views, functions, stored procedures (saved pieces of SQL code that run on the server), triggers (code that runs automatically when data changes) and synonyms (alternative names for other objects).
- **Read the code.** Open any procedure, view, function or trigger and see its SQL, plus a plain outline of what it does: which tables it reads and writes, and which other procedures it calls.
- **See what uses what.** For every object, see what it uses and what uses it. There is also a map of the whole database that you can zoom into.
- **See scheduled jobs.** SQL Server Agent jobs and Azure Elastic Jobs, with their steps, schedules and recent runs.
- **Get a health report.** 25 automatic checks ("audit insights") point out things worth a look: unused code, risky patterns, broken references, tables without a primary key, failing or slowing jobs, and more.
- **Ask AI to explain things (optional).** If you add your own Anthropic API key, the app can explain a procedure or job in plain English, or review the health report for you.

db-audit saves a copy of what it reads on your computer. After the first read, browsing is fast and does not put load on your server. You choose when to read the database again.

## Contents

- [Is it safe?](#is-it-safe)
- [What you need](#what-you-need)
- [Install and start](#install-and-start)
- [Connect your database](#connect-your-database)
  - [The connection form](#the-connection-form)
  - [Sign-in methods](#sign-in-methods)
  - [Permissions the login needs](#permissions-the-login-needs)
- [Your first refresh](#your-first-refresh)
- [A tour of the app](#a-tour-of-the-app)
- [Audit insights](#audit-insights)
- [AI explanations (optional)](#ai-explanations-optional)
- [Where your data lives](#where-your-data-lives)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)
  - [npm scripts](#npm-scripts)
  - [Environment variables](#environment-variables)
  - [Advanced settings (settings.json)](#advanced-settings-settingsjson)
  - [REST API](#rest-api)
- [Try it with the demo database](#try-it-with-the-demo-database)
- [For contributors](#for-contributors)
- [License](#license)

## Is it safe?

Short answer: it is built to be.

- **Read-only.** Every query the app sends to a database first goes through a checker. The checker blocks anything that could write or change something (see [Read-only guarantee](#read-only-guarantee) for details). Queries also have a time limit, and they give up instead of waiting forever on locked data.
- **Local only.** The app only listens on your own computer (`127.0.0.1`). Other machines on your network cannot reach it.
- **Your data stays with you.** The copy of your database structure is saved in the `data/` folder of this project. Nothing is uploaded anywhere. The one exception is the optional AI feature, and only when you click its button (see [AI explanations](#ai-explanations-optional)).

One thing to be aware of: if you sign in with a SQL login (user name and password), the password is saved **as plain text** in `data/connections.json`. Microsoft Entra ID sign-in avoids this. See [Sign-in methods](#sign-in-methods).

## What you need

| What | Why | Required? |
|---|---|---|
| [Node.js](https://nodejs.org/) **22 or newer** | Runs the app. Check with `node -v`. | Yes |
| A SQL Server, Azure SQL Database or Azure SQL Managed Instance database | The thing you want to look at. | Yes (or use the [demo database](#try-it-with-the-demo-database)) |
| A login with read permissions | See [Permissions the login needs](#permissions-the-login-needs). | Yes |
| [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`) | Only for the "Entra – Azure CLI" sign-in method. | Optional |
| An [Anthropic API key](https://console.anthropic.com/) | Only for the AI explanations. | Optional |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Only for the demo database and the automated tests. | Optional |

## Install and start

1. Open a terminal in the project folder.

2. Install the app. The web interface lives in the `web/` folder and has its own packages, so there are **two** install commands:

   ```bash
   npm install
   npm --prefix web install
   ```

3. Start it. Pick one of these two ways.

   **Option A: normal use.** Build the web interface once, then start the app:

   ```bash
   npm run build
   npm start
   ```

   The terminal prints a line like `[db-audit] listening on http://127.0.0.1:4000`. Open **http://127.0.0.1:4000** in your browser.

   Run `npm run build` again after you update the code. If you skip the build, the app still starts, but only the API runs and there is no web page to open.

   **Option B: development mode.** One command starts both the app and a live-reloading web interface:

   ```bash
   npm run dev
   ```

   Open **http://localhost:5173**. Changes to the code show up straight away. Press **Ctrl-C** to stop both.

4. The first time, you land on the **Connections** page, which says **"Connect your first database"**. Carry on with the next section.

To use a different port than 4000, set `PORT`, for example `PORT=4500 npm start`.

## Connect your database

Click **Add connection**. Fill in the form, then click **Save & test**.

### The connection form

| Field | What to put there |
|---|---|
| **Name** | Any name you like, for example "Sales database". |
| **Server** | The server address, for example `myserver.database.windows.net`. These forms also work: `host,port`, `tcp:host,port` and `host\instance` (a named instance). For the public endpoint of a Managed Instance, use port `3342`. |
| **Database** | The database to look at, for example `MyDatabase`. |
| **Port** | Optional. Leave empty for the default (1433). |
| **Mode** | How to sign in. See [Sign-in methods](#sign-in-methods). |
| **Encrypt** | Encrypt the connection. On by default. Leave it on for Azure. |
| **Trust server certificate** | Skip checking the server's certificate. Only turn this on for a local or test server that uses a self-signed certificate. |
| **Read-only intent** | Tells the server this connection only reads. Useful when you connect to a read-only copy of the database (for example a failover group's read-only listener). |
| **Jobs source** | Where to look for scheduled jobs: **Auto** (the default), **SQL Agent (msdb) only**, **Elastic Jobs only**, or **No jobs**. |
| **Elastic Jobs database** | Optional, in a folding section. Azure Elastic Jobs keep their job list in a separate "job database", which can be on a different server. Tick **Read Elastic Jobs from a job database** and enter its server, database and port. |

About jobs:

- **SQL Server Agent jobs** exist on SQL Server and on Azure SQL Managed Instance. **Azure SQL Database has no SQL Agent.**
- With **Auto**, the app reads SQL Agent jobs when the server has them and the login may read them. It also reads Elastic Jobs when you filled in a job database.

When you click **Save & test**, the app saves the connection and tries to connect. It shows the server version, the login it used, and which permissions are present or missing. For each missing permission it shows the SQL that would fix it.

If you have more than one connection, use the switcher in the sidebar to choose which one you are looking at.

### Sign-in methods

| Mode in the form | When to use it | What to do |
|---|---|---|
| **SQL login** | You have a SQL user name and password. | Enter **User** and **Password**. The password is saved **in plain text** in `data/connections.json` (the file can only be read by your user account). Prefer one of the Entra methods if you can. |
| **Entra – Azure CLI** | You use the Azure CLI on this computer. | Run `az login` in a terminal first. If your account belongs to several Azure tenants (organisations), fill in **Tenant ID**. |
| **Entra – Browser sign-in** | You want a normal Microsoft sign-in page. | A browser window opens to sign in, once each time the app starts. **Tenant ID** and **Client ID** are optional. |
| **Entra – Default chain** | The app runs somewhere with an Azure identity already set up (for example environment variables or a managed identity). | Nothing to enter in most cases. **Client ID** here means the managed identity's client ID. On a laptop, start the app with `AZURE_TOKEN_CREDENTIALS=dev` so it skips the slow managed-identity check. |

Microsoft Entra ID is Microsoft's sign-in system for Azure (it used to be called Azure Active Directory). With the Entra methods, the app never stores a password. The sign-in tokens it gets are kept in memory only and are gone when the app stops.

### Permissions the login needs

The app reads the database's catalog (its built-in list of objects and their code). The login needs permission to see that. Ask your database admin to run the SQL below, or run it yourself if you are the admin. Replace `auditor@contoso.com` with the real user.

**1. In the database you want to look at:**

```sql
-- Create the user. For a Microsoft Entra account:
CREATE USER [auditor@contoso.com] FROM EXTERNAL PROVIDER;
-- (For a SQL login instead: CREATE USER [audit_user] FOR LOGIN [audit_user];)

-- Required: lets the user see all objects and their code.
GRANT VIEW DEFINITION TO [auditor@contoso.com];

-- Strongly recommended: lets the app read which object uses which, all at once.
-- Without it the app falls back to a slower method and misses table-level links
-- (for example from computed columns and constraints).
GRANT SELECT ON sys.sql_expression_dependencies TO [auditor@contoso.com];

-- Optional: exact row counts and table sizes.
-- Without it row counts are approximate and sizes are not shown.
GRANT VIEW DATABASE STATE TO [auditor@contoso.com];
```

**2. For SQL Server Agent jobs (SQL Server and Managed Instance only).** Agent jobs live in the `msdb` system database on the same server:

```sql
USE master;  CREATE LOGIN [auditor@contoso.com] FROM EXTERNAL PROVIDER;   -- Managed Instance: server-level Entra login
USE msdb;    CREATE USER  [auditor@contoso.com] FOR LOGIN [auditor@contoso.com];
             ALTER ROLE SQLAgentReaderRole ADD MEMBER [auditor@contoso.com];
```

`SQLAgentReaderRole` is a built-in role that may view jobs but not change them. On a regular SQL Server, use your existing login instead of the `CREATE LOGIN` line.

**3. For Azure Elastic Jobs.** In the job database:

```sql
CREATE USER [auditor@contoso.com] FROM EXTERNAL PROVIDER;
ALTER ROLE jobs_reader ADD MEMBER [auditor@contoso.com];   -- may read the job list, not change it
```

If the job permissions are missing, nothing breaks. The refresh still works, it shows a warning, and the **Jobs** list stays empty.

## Your first refresh

A new connection starts out empty. db-audit only reads your database when you ask it to. This is called a **refresh**.

1. Click **Refresh** in the top bar (or **Run first refresh** on an empty page).
2. Choose which parts to read. All of them are ticked by default:
   - **Tables, Views, Functions, Procedures, Triggers**: the objects and their code.
   - **Dependencies**: which object uses which.
   - **Jobs**: SQL Agent and Elastic Jobs.
   - **Analysis**: the app's own reading of your code (what each piece reads, writes and calls). This step works on the saved copy and does not touch the database. The health checks need it.
3. Choose a mode:
   - **Incremental** (the default): only reads objects that are new or changed since last time, judged by their "last modified" date. Objects that were deleted are removed. Jobs are always read in full, because there is little job data.
   - **Full**: reads everything again.
4. Click **Run refresh**. You see live progress. You can **Cancel**, or close the window with **Run in background** and keep browsing.
5. When it finishes, you get a summary of what was added, updated and removed, plus any warnings. Many warnings come with a hint on how to fix them.

Notes:

- Only one refresh can run at a time for each connection.
- On any object's page you can click **Refresh object** to read just that one object again.
- If one part fails (for example jobs, because of permissions), the other parts are still saved. The parts that failed keep their previous data.
- Large databases can take a while the first time. Later incremental refreshes are much faster.

## A tour of the app

The sidebar lists the pages. Press **/** or **Cmd/Ctrl+K** anywhere to open **quick search** and jump to any object, job or page. The sun/moon button in the top bar switches between light and dark mode.

| Page | What you see |
|---|---|
| **Overview** | Counts of each kind of object, when the last refresh ran, its warnings, recent refresh runs, the [audit insights](#audit-insights), and the **AI analysis** panel with its **Analyze** button. |
| **Procedures, Tables, Views, Functions, Triggers** | A list of each kind. Filter by name, pick a schema from the dropdown, and sort the columns. Small badges flag things such as dynamic SQL, references to other databases, writes to tables, and encrypted code. Tables show row counts. |
| **Object page** (click a procedure, view, function or trigger) | Tabs: **Explain** (the code next to an outline: the tables it touches, its statements and the procedures it calls), **Dependencies** (**Uses** and **Used by**, including jobs that call it), **Diagram** (a picture of its connections), **AI explanation**. |
| **Table page** | Tabs: **Structure & usage** (columns, keys, indexes, foreign keys, and which code and jobs use the table) and **Diagram**. |
| **Jobs** | All scheduled jobs. A job's page shows its schedules and the tabs **Steps**, **Executions** (recent runs and their results), **Diagram** and **AI explanation**. |
| **Graph** | A map of the whole database. Search for an object to focus on it, choose how many steps out to show (depth 1 to 4), and switch kinds of objects and kinds of links (reads, writes, calls, and so on) on or off. Click a box to see details in a side panel. |
| **Refresh history** | Every past refresh, with its result, counts and warnings. |
| **Settings** | **AI explanations** (API key, model, effort), **Appearance** (System, Light or Dark) and **Privacy** (**Reset consent**, see [AI explanations](#ai-explanations-optional)). |
| **Connections** | Add, edit, test and delete connections. |

## Audit insights

Audit insights are 25 automatic checks shown on the **Overview** page. They are worked out from the saved copy on your computer, so they send no queries to your database. Some of them need the **Analysis** part of a refresh, so keep that part ticked.

Treat each finding as "worth a look", not as "definitely wrong". The app cannot see your applications, so for example a procedure that nothing in the database calls might still be called by an application.

| Group | Check | What it means |
|---|---|---|
| **Usage** | Most-referenced tables | Tables used by the most code. Changes to these affect the most things. |
| | Orphan procedure candidates | Procedures that nothing in this database calls. Maybe unused, maybe only called by an application. |
| | Unreferenced tables | Tables that no code or job in this database reads or writes. |
| **Code risk** | Dynamic SQL | Code that builds SQL as text and runs it. Hard to track, and a possible SQL-injection risk. |
| | Cross-database and linked-server references | Code that reaches into other databases or servers. It breaks if those move or are renamed. |
| | Transactions without TRY/CATCH | Code that starts a transaction but has no error handling. An error can leave locks held. |
| | Cursors | Code that processes rows one at a time. Usually slower than working on all rows at once. |
| | EXECUTE AS (impersonation) | Code that runs with someone else's permissions. Worth a security review. |
| | ANSI_NULLS / QUOTED_IDENTIFIER off | Code created with old settings that change how NULLs and quotes behave. |
| | Modules without a readable definition | Encrypted or CLR code, or code this login may not read. It cannot be checked. |
| | SELECT * | Code that selects all columns. Adding or removing a column can silently change its results. |
| **Dependency health** | Stale modules (do not compile) | Code that refers to columns or objects that no longer exist. It would fail if run today. |
| | References to missing objects | Code that points at objects that do not exist. It fails when that part runs. |
| | Dependency read failures | Objects whose links the server could not report. Their dependency info is incomplete. |
| | Unresolved or ambiguous references | Names the server could not match to exactly one object. |
| **Schema health** | Tables without a primary key | Rows cannot be told apart reliably, and duplicates can go unnoticed. |
| | Untrusted or disabled foreign keys | Links between tables that are switched off or not checked. Existing data may break them. |
| | Disabled indexes | Indexes that are switched off. A disabled clustered index makes the whole table unreadable. |
| | Disabled triggers | Triggers that are switched off, so their logic is not running. |
| | Largest tables | The biggest tables by row count. Useful background for planning. |
| **Jobs and operations** | Failing jobs | Jobs whose last run failed. |
| | Disabled jobs | Jobs that are switched off. |
| | Enabled jobs without a schedule | Jobs that are switched on but will never run by themselves. |
| | Jobs getting slower | Jobs whose last 5 successful runs took on average at least 1.5 times as long, and at least 60 seconds longer, than earlier runs. |
| | Job steps that ignore failure | SQL Agent steps set to carry on or report success when they fail, so nobody is alerted. |

## AI explanations (optional)

If you want, db-audit can ask Claude (Anthropic's AI) to explain things in plain English. This is off until you add an API key. AI calls are billed by Anthropic to **your** API key.

There are two AI features:

- **Explain with AI**, on the **AI explanation** tab of an object or job. You get a summary, its purpose, the main steps (with line numbers), the data it touches, and possible risks.
- **Analyze**, in the **AI analysis** panel on the Overview page. You pick groups of audit insights, and the AI turns them into a prioritised review with recommendations and quick wins.

**What is sent to Anthropic:**

| Feature | Sent | Never sent |
|---|---|---|
| Explain with AI (object) | The object's name and code, the app's notes about it (tables, calls, outline), and the column names and types of the tables it uses. | Server names, logins, passwords, connection settings. |
| Explain with AI (job) | The job's name, description, schedules and steps, including each step's code, and short summaries of procedures the steps call. | Server names, logins, passwords, connection settings, job owners. |
| Analyze (insights) | Object counts, the selected insights, the names of the objects they list, and short facts about those objects. **No code.** | Code, server names, logins, passwords, connection settings. |

Your code is your property. Only use these features on code you are allowed to share with Anthropic. The app asks for your OK once per browser before it sends anything. You can take that OK back with **Settings > Privacy > Reset consent**.

**Turning it on:**

- In the app: **Settings > AI explanations**, paste your key, click **Save key**. The key is saved in `data/settings.json` on your computer. The app never shows it again in the browser.
- Or: start the app with the `ANTHROPIC_API_KEY` environment variable set. A key saved in Settings takes priority.

On the same page you can change the **Model** (default `claude-opus-5-5`) and the **Effort** (Low, Medium, High, Extra high; default **Medium**). Higher effort is more thorough but slower.

**Turning it off:**

- Remove the key (**Clear key** in Settings) and unset `ANTHROPIC_API_KEY`.
- To be completely sure no AI request is ever made, start the app with `DB_AUDIT_AI=off`.

Results are saved, so opening the same explanation again costs nothing. If the code changes later, the saved explanation is marked as out of date and you can generate a new one.

## Where your data lives

Everything is stored in the `data/` folder of this project. You can use a different folder by setting `DB_AUDIT_DATA_DIR`.

| File | What it holds |
|---|---|
| `data/connections.json` | Your saved connections. **SQL login passwords are stored here in plain text.** |
| `data/settings.json` | App settings and your AI key, if you saved one. Created automatically with default values on first start. |
| `data/cache/<connection id>.sqlite` | The saved copy of one database: object lists, **the code of your procedures, views, functions and triggers**, job steps, and AI explanations. It is a SQLite file (a single-file database). |

Security tips:

- **Treat the `data/` folder like source code.** It contains your database code, and maybe a password or API key. Do not share it or put it in a public place. The project's `.gitignore` already keeps `data/` out of Git.
- The files are created so that only your user account can read them.
- Prefer an Entra sign-in method over a SQL login, so no password is saved.
- If you change a connection's server, database or port, or delete the connection, its saved copy is deleted too.
- The app only accepts requests from your own computer.

### Read-only guarantee

Every query the app sends to a database (your database, `msdb` or an Elastic Jobs database) is checked first. The check blocks any statement that could write or change something, such as `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `EXEC`, `GRANT`, `DBCC`, `BACKUP` and `RESTORE`. There are two narrow exceptions:

- Filling a temporary in-memory table variable (`INSERT INTO @table`) inside a query. This only exists while the query runs and changes nothing in the database.
- Running four built-in, read-only SQL Agent procedures in `msdb`: `sp_help_job`, `sp_help_jobstep`, `sp_help_jobschedule` and `sp_help_jobhistory`. Logins with `SQLAgentReaderRole` cannot read the job tables directly, so this is the only way for them to see jobs.

On top of that, each query has a lock timeout (it gives up instead of waiting on locked data) and a time limit. You can also tick **Read-only intent** on the connection.

The checker is in `server/db/readOnlyGuard.ts`, and an automated test runs it over every SQL statement the app uses.

## Troubleshooting

**`npm run dev` says port 5173 is in use.**
The web interface needs port 5173 and will not pick another one. Close the other program that uses it, or use `npm run build` and `npm start` instead.

**`npm run dev` only starts the server.**
The web packages are missing. Run `npm --prefix web install`, then `npm run dev` again.

**I open http://127.0.0.1:4000 and there is no page.**
The web interface is not built. Run `npm run build`, then `npm start` again.

**A page says "Nothing cached yet".**
This connection has not been refreshed yet. Click **Run first refresh** or **Refresh** in the top bar.

**The Jobs list is empty.**
Check these in order:
- Azure SQL Database has no SQL Agent. Jobs only show up from Elastic Jobs, and only if you entered the job database on the connection.
- The **Jobs source** on the connection might be set to **No jobs**.
- The login may be missing job permissions. Look for a warning like "Agent jobs not readable (needs SQLAgentReaderRole in msdb)" in the refresh summary, and see [Permissions](#permissions-the-login-needs).
- The **Jobs** part was not ticked in the last refresh.

**Audit insights say "Analysis not available".**
Run a refresh with the **Analysis** part ticked.

**"AI not configured — add a key in Settings".**
Add your Anthropic API key in **Settings**, or start the app with `ANTHROPIC_API_KEY` set. If the app was started with `DB_AUDIT_AI=off`, AI stays off.

**"A refresh is already running".**
Only one refresh can run per connection. Wait for it to finish, or cancel it from the refresh window. You also cannot edit or delete a connection while it is being refreshed.

**Login failed, or permission errors.**
- SQL login: check the user name and password.
- Entra – Azure CLI: run `az login` again. Your sign-in may have expired. If you belong to several tenants, set **Tenant ID**.
- Use **Test connection** on the Connections page. It lists missing permissions and the SQL to fix them.
- Certificate errors on a local or test server: tick **Trust server certificate**. Do not do this for production servers.

**The demo database will not start on an Apple Silicon Mac.**
The demo uses the Intel (amd64) SQL Server image, which Docker runs through Rosetta (Apple's Intel emulator). If the container does not start, check that Docker Desktop's Rosetta / x86 emulation option is turned on. The project uses SQL Server 2022 on purpose, because the newer 2025 image crashes under Rosetta.

---

## Reference

The sections below are for advanced use. You do not need them to use the app.

### npm scripts

Run these from the project folder.

| Command | What it does |
|---|---|
| `npm start` | Starts the app on http://127.0.0.1:4000. It serves the built web interface if `web/dist` exists. |
| `npm run dev` | Starts the app (restarts on code changes) and the live web interface on http://localhost:5173 together. Ctrl-C stops both. |
| `npm run dev:server` | Starts only the app server, restarting on code changes. |
| `npm run build` | Builds the web interface into `web/dist`. |
| `npm run typecheck` | Checks the TypeScript code for type errors. |
| `npm test` | Runs all automated tests. |
| `npm run test:server` | Runs only the server tests. |
| `npm run test:e2e` | Runs the browser tests (see [For contributors](#for-contributors)). |
| `npm run db:up` | Starts the demo SQL Server in Docker and waits until it is ready. |
| `npm run db:seed` | Creates (or re-creates) the demo databases, jobs and logins. |
| `npm run db:down` | Stops the demo SQL Server. Its data is kept. |
| `npm run db:reset` | Deletes the demo SQL Server and its data, then creates and seeds it again. |

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port the app listens on. |
| `DB_AUDIT_DATA_DIR` | `data/` in the project | Folder for connections, settings and saved copies. |
| `ANTHROPIC_API_KEY` | not set | Anthropic API key for the AI features. A key saved in Settings wins over this. |
| `DB_AUDIT_AI` | not set | Set to `off` to switch off all AI features. |
| `AZURE_TOKEN_CREDENTIALS` | not set | Read by Microsoft's Azure sign-in library, not by db-audit itself. Set to `dev` on a laptop when using **Entra – Default chain**. |
| `DB_AUDIT_API` | `http://127.0.0.1:4000` | Development mode only: where the live web interface sends API calls. Change it if the app server runs on another port. |
| `E2E_PORT` | `4100` | Browser tests only: port for the test server. |
| `E2E_DATA_DIR` | a `db-audit-e2e` folder in your system's temp folder | Browser tests only: data folder for the test server. It is wiped at the start of each run. |
| `DB_AUDIT_QUERY_FOLDER` | not set | Optional, contributors only: a folder of your own .sql files for the analyzer's robustness and speed tests. If not set, the robustness test is skipped and the speed test uses only the built-in samples. |

### Advanced settings (settings.json)

`data/settings.json` is created on first start. You can edit these numbers by hand, then restart the app. Missing or invalid values fall back to the defaults.

| Key | Default | What it controls |
|---|---|---|
| `dependencyConcurrency` | `4` | How many dependency queries run at the same time. Maximum 4. Lower it to go easier on the server. |
| `lockTimeoutMs` | `30000` (30 s) | How long a query waits for locked data before giving up. |
| `requestTimeoutMs` | `120000` (2 min) | Time limit for each query. |
| `bulkQueryTimeoutMs` | `300000` (5 min) | Time limit for the one large query that reads all dependencies at once. |
| `refreshTimeoutMs` | `3600000` (60 min) | Time limit for a whole refresh. A refresh that takes longer is stopped and marked as failed. |
| `executionsPerJob` | `200` | How many recent runs to keep for each job. |
| `graphNodeCap` | `2000` | Most boxes the Graph page shows at once. |
| `apiKey`, `aiModel`, `aiEffort` | not set | AI key, model and effort. These are written by the Settings page; you do not need to edit them by hand. |

### REST API

The web interface talks to the app through a JSON API under `/api`. You can use it from scripts too (it only accepts requests from your own computer). The request and response types are in `shared/types.ts`. Errors come back as `{ "error": "...", "details": ... }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Check that the app is running. |
| GET | `/api/connections` | List connections. |
| POST | `/api/connections` | Create a connection. |
| GET | `/api/connections/:id` | Get one connection (never includes the password). |
| PUT | `/api/connections/:id` | Update a connection. |
| DELETE | `/api/connections/:id` | Delete a connection and its saved copy. |
| POST | `/api/connections/:id/test` | Test the connection and check permissions. |
| GET | `/api/connections/:id/summary` | Counts, last refresh and warnings. |
| POST | `/api/connections/:id/refresh` | Start a refresh. Body: `{ "segments": "all" or [...], "mode": "incremental" or "full", "objects"?: [...] }`. Returns `202 { runId }`. |
| GET | `/api/connections/:id/refresh` | List past refresh runs (`?limit=`, `?before=`). |
| GET | `/api/connections/:id/refresh/:runId` | Status and progress of one refresh run. |
| POST | `/api/connections/:id/refresh/:runId/cancel` | Cancel a running refresh. |
| GET | `/api/connections/:id/objects` | List objects (`?kind=`, `?q=`). |
| GET | `/api/connections/:id/objects/:kind/:schema/:name` | Details of one object. |
| GET | `/api/connections/:id/jobs` | List jobs. |
| GET | `/api/connections/:id/jobs/:jobId` | Details of one job. |
| GET | `/api/connections/:id/insights` | The audit insights report. |
| POST | `/api/connections/:id/insights/analyze` | AI review of selected insight groups. Body: `{ "categories": [...], "force"?: true }`. |
| GET | `/api/connections/:id/insights/analysis` | A saved AI review, if any (`?categories=a,b`). |
| GET | `/api/connections/:id/graph` | The dependency map (`?focus=`, `?depth=1..4`, `?kinds=a,b`). |
| GET | `/api/ai/status` | Whether AI is set up, plus model and effort. Never returns the key. |
| PUT | `/api/ai/settings` | Save the AI key, model or effort. Body: `{ "apiKey"?, "model"?, "effort"? }`; `"apiKey": null` removes the key. |
| POST | `/api/connections/:id/objects/:kind/:schema/:name/describe` | AI explanation of one object. Body: `{ "force"?: true }` to make a new one. |
| POST | `/api/connections/:id/jobs/:jobId/describe` | AI explanation of one job. Body: `{ "force"?: true }`. |

Only one refresh can run per connection. Starting a second one returns `409`.

---

## Try it with the demo database

Don't have a database at hand, or want to work on the code? The project includes a small demo SQL Server that runs in Docker. You need Docker Desktop for this.

```bash
npm run db:up     # starts SQL Server 2022 in a container named db-audit-mssql, on 127.0.0.1:14340
npm run db:seed   # creates the demo databases, jobs and logins
```

- This creates two demo databases, `AuditDemo` and `AuditArchive`, a pretend Elastic Jobs database `AuditJobs`, and a few SQL Agent jobs.
- In the app, add a connection with server `localhost`, port `14340`, database `AuditDemo`, **Trust server certificate** ticked, sign-in **SQL login**, user `audit_full`. The password is the `DB_AUDIT_FULL_PASSWORD` value in `dev/.env.dev`. These are throwaway passwords for the local demo only.
- To see Elastic Jobs too, open **Elastic Jobs database**, tick the box, and enter server `localhost`, job database `AuditJobs`, port `14340`.
- On Apple Silicon Macs the container runs through Rosetta (see [Troubleshooting](#troubleshooting)).
- Stop it with `npm run db:down`. Start over from scratch with `npm run db:reset`.

## For contributors

Project layout:

| Folder | What is in it |
|---|---|
| `server/` | The app server (Node.js, Express): API, database reading, refresh, the built-in SQL code analyzer, audit insights, AI. |
| `web/` | The web interface (React, Vite). Has its own `package.json`. |
| `shared/` | Types used by both the server and the web interface. |
| `dev/` | The demo SQL Server: Docker setup, seed scripts and helper scripts. |
| `test/` | Automated tests for the server and the code analyzer. |

Tests:

- `npm run typecheck` checks types.
- `npm test` runs all tests. `npm run test:server` runs only the server tests.
- The analyzer tests (`test/analyze`) need no Docker.
- The integration tests need the demo database running and seeded (`npm run db:up`, then `npm run db:seed`). If it is not reachable, they are skipped with a message instead of failing.
- Browser (end-to-end) tests:
  1. Start and seed the demo database.
  2. Run `npm run build`.
  3. Run `npm run test:e2e`. It starts its own app server on port 4100 with a temporary data folder, so your real `data/` folder is not touched.

  The browser tests use Playwright. If Playwright says the browser is missing, run `npx playwright install chromium` inside the `web/` folder once.

## License

Copyright (c) 2026 haidervf.

db-audit is free to use, copy and change for personal use, study, research, hobby projects, and for non-profit, charity, education and government use. This is under the [PolyForm Noncommercial License 1.0.0](LICENSE) (full text: <https://polyformproject.org/licenses/noncommercial/1.0.0>).

Not allowed without written permission from the author: commercial use. For example, using it in or for a business, selling it, or offering it as a paid service.

For commercial use, contact the author on GitHub: <https://github.com/haidervf>.
