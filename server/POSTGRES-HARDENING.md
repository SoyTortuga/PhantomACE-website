# Postgres hardening — runbook

Two jobs, done in this order, on the rig. Off-stream: the second one
restarts the site.

1. **Bind Postgres to localhost.** It currently listens on `0.0.0.0`, so
   anything that can reach the machine can reach the database.
2. **Rotate the `postgres` password.** It has been pasted into a chat
   window, so it should be considered known.

They are separate on purpose. If step 1 goes wrong you still have working
credentials; if you did both at once you would not know which broke it.

---

## Before you start: where the password actually lives

**Not only in `server\.env`.** That file holds the **dev** connection
string. Production's lives in the Windows service's own environment
block, because both processes run from the same directory and a single
`.env` cannot tell them apart (see `server/lib/service-env.js`).

| Where | Which database | How to read it |
|---|---|---|
| `server\.env` → `DATABASE_URL` | `phantomace-tv-dev` | open the file |
| `phantomace-web` service → `AppEnvironmentExtra` | `phantomace-tv` | `nssm get phantomace-web AppEnvironmentExtra` |
| a `phantomace-web-dev` service, if one exists | `phantomace-tv-dev` | same, with that name |

Find every service first, so nothing is missed:

```bash
Get-Service phantomace* | Select Name, Status
```

Both databases use the same `postgres` role, so **one password change
affects both** and every place above must be updated together.

---

## Part 1 — bind to localhost

### 1.1 Find the config file

```bash
psql -U postgres -c "SHOW config_file;"
```

If `psql` is not on PATH it is at
`C:\Program Files\PostgreSQL\18\bin\psql.exe`, and the file is almost
certainly `C:\Program Files\PostgreSQL\18\data\postgresql.conf`.

Confirm what it does now:

```bash
psql -U postgres -c "SHOW listen_addresses;"
```

### 1.2 Edit `postgresql.conf`

Find the `listen_addresses` line and set it to:

```
listen_addresses = 'localhost'
```

Uncomment it if it is commented out. Leave `port = 5432` alone.

### 1.3 Check `pg_hba.conf` too

`listen_addresses` decides which interfaces accept a connection;
`pg_hba.conf` decides who may authenticate. Both matter. In the same
folder, open `pg_hba.conf` and look for any line whose address is not
local — anything like `0.0.0.0/0` or a LAN range:

```
host    all    all    0.0.0.0/0    scram-sha-256      <-- remove or narrow
```

The lines you want to keep are the `127.0.0.1/32` and `::1/128` ones.
Comment out the rest rather than deleting, so it is obvious what changed.

### 1.4 Restart and verify

```bash
Restart-Service postgresql-x64-18
```

It should now be listening only on loopback:

```bash
netstat -ano | findstr ":5432"
```

Expect `127.0.0.1:5432` and possibly `[::1]:5432`. **If you see
`0.0.0.0:5432` the edit did not take** — check you edited the file that
`SHOW config_file` named.

The site reconnects by itself (`lib/db.js` retries with backoff). Confirm:

```bash
curl.exe -s http://127.0.0.1:8789/api/health
```

Expect `{"ok":true,"database":"up",...}`.

### Rollback

Put `listen_addresses` back to what it was and restart the service.

---

## Part 2 — rotate the password

### 2.1 Generate one

```bash
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
```

Letters and digits only, deliberately: a password containing
`@ : / ? # [ ] %` has to be percent-encoded inside a `DATABASE_URL` and
that is an easy thing to get wrong at the worst moment.

Keep it in your password manager. **Do not paste it into a chat window,
including this one** — that is the reason this job exists.

### 2.2 Update the config files FIRST

Nothing re-reads these until a restart, so the running site is unaffected.
Doing them first shrinks the window in step 2.3 to a few seconds.

**`server\.env`** — change the password inside `DATABASE_URL`, leaving the
rest of the line alone:

```
DATABASE_URL=postgres://postgres:NEWPASSWORD@localhost:5432/phantomace-tv-dev
```

**The service** — read what is there now:

```bash
nssm get phantomace-web AppEnvironmentExtra
```

> **`nssm set` REPLACES the whole block.** If that command prints five
> variables and you set one, the other four are gone and the service will
> not boot — `index.js` refuses to start without its secrets. Copy the
> full output somewhere first, change only the password inside
> `DATABASE_URL`, and pass **every** variable back:

```bash
nssm set phantomace-web AppEnvironmentExtra 'DATABASE_URL=postgres://postgres:NEWPASSWORD@localhost:5432/phantomace-tv' 'PUBLIC_ORIGIN=https://phantomace.tv'
```

Add any other lines `nssm get` printed. Then read it back and compare
against what you copied:

```bash
nssm get phantomace-web AppEnvironmentExtra
```

Repeat for any `phantomace-web-dev` service.

### 2.3 Change it in Postgres, then restart

Run these two back to back. Between them the site keeps serving on
connections it already holds, but a **new** pool connection would fail —
so do not pause here.

```bash
psql -U postgres
```
then inside psql:
```
\password postgres
```

`\password` prompts twice and hashes client-side, so the plaintext never
reaches the server log or `pg_stat_activity`. **Do not use
`ALTER USER postgres WITH PASSWORD '...'`** — that puts the password in
both.

`\q` to exit, then immediately:

```bash
nssm restart phantomace-web
```

### 2.4 Verify

```bash
curl.exe -s http://127.0.0.1:8789/api/health
curl.exe -s http://127.0.0.1:8789/api/forum/categories
```

The first should say `"database":"up"`, the second should return the six
boards. Then from outside, `https://phantomace.tv/api/health`.

Check a maintenance script can still reach production:

```bash
node server/scripts/whoami-bot.js --service phantomace-web
```

That reads `DATABASE_URL` out of the service environment, so it proves
step 2.2 landed correctly.

### If the site does not come back

`nssm status phantomace-web`, then the service's stderr log. The two
likely causes:

- **`password authentication failed`** — the `DATABASE_URL` you set does
  not match what you typed into `\password`. Fix the service env and
  restart.
- **the service exits at boot naming a missing secret** — `nssm set`
  replaced the whole block and dropped the others. Put them all back.

### Rollback

There is none for the password: the old one is gone the moment
`\password` completes. That is why step 2.2 comes first and why the new
password goes into your password manager **before** step 2.3.

---

## Afterwards

- The old password is in this repository's chat history and nowhere else
  that matters. Nothing in the repo contains it — `server/.env` is
  gitignored.
- If you ever add a second machine that needs the database, it now needs
  a tunnel or an explicit `pg_hba.conf` line, which is the point.
