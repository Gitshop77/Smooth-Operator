# Operations Runbook — Cockpit + cowork-events

Practical operational guidance for running the Open Cowork **Cockpit** dashboard
(Next.js, port 3000) and the **cowork-events** mini-service (WebSocket/port 3003)
in production. The browser extension itself is a static unpacked load and needs
no server ops beyond what is documented here.

> Safety baseline: bind everything to `127.0.0.1` (or an internal network you
> control). Never expose the Cockpit or the events service to `0.0.0.0` on a
> public host. The Cockpit and events service expect a trusted, private network.

---

## 1. Tokens & secrets

Two shared secrets gate the services (see `mini-services/cowork-events/index.ts`
and `cockpit/.env.example`):

- `COWORK_EVENT_TOKEN` — service-to-service (S2S) secret between the Cockpit and
  the events mini-service.
- `COWORK_UI_TOKEN` — browser-facing UI auth secret. **MUST differ** from
  `COWORK_EVENT_TOKEN`; the events service refuses to authenticate browser
  sockets with the S2S token unless `COWORK_UI_TOKEN` is set (it warns and falls
  back, which you do not want in production).

### Token rotation

1. Generate fresh, high-entropy values (e.g. `openssl rand -hex 32`).
2. Set the new `COWORK_EVENT_TOKEN` and `COWORK_UI_TOKEN` in the Cockpit's
   `.env` and in the events mini-service environment, keeping them **equal
   within a single deploy** so the two services agree, while `COWORK_UI_TOKEN`
   is distinct from `COWORK_EVENT_TOKEN`.
3. Restart the events mini-service first, then the Cockpit, so both pick up the
   new secrets together.
4. Roll the extension's stored token if it caches one (the extension reads the
   UI token from the Cockpit at connect time) — reconnect the side panel.
5. Rotate on a schedule (e.g. 90 days) and immediately on any suspected leak.

> `NEXT_PUBLIC_COWORK_UI_TOKEN` is a build-time, **client-exposed** value. Never
> set it equal to `COWORK_EVENT_TOKEN` on any host reachable from an untrusted
> network — that would let a browser bundle unlock the S2S path.

---

## 2. Breach response

1. **Rotate immediately** all `COWORK_*` tokens (Section 1) and any provider API
   keys stored in the extension/Cockpit.
2. **Contain**: stop the events mini-service and the Cockpit (`docker stop` /
   `systemctl stop` / kill the process) if you cannot isolate the network fast.
3. **Preserve evidence**: copy the SQLite databases and logs before any wipe.
4. **Audit**: review Cockpit run history / event logs for unauthorized actions;
   check the erasure endpoints if data must be purged.
5. **Restore** from a known-good backup (Section 3) after rotating secrets.
6. File a report to **security@opencowork.dev**.

---

## 3. SQLite backup & restore

Both the Cockpit and the events mini-service persist to local SQLite files.

- Cockpit DB: `cockpit/db/cowork.db` (path via `DATABASE_URL`).
- events service DB: its configured SQLite path (see `mini-services/cowork-events`).

### Backup

```bash
# Cockpit
cp cockpit/db/cowork.db cockpit/db/cowork.db.bak-$(date +%F-%H%M)

# events mini-service (substitute its actual db path)
cp mini-services/cowork-events/db/cowork-events.db \
   mini-services/cowork-events/db/cowork-events.db.bak-$(date +%F-%H%M)
```

Take backups while the service is stopped, or use `.dump` (`sqlite3 db ".dump" > backup.sql`) to get a consistent snapshot under load.

### Restore

```bash
# Stop the service, then:
cp cockpit/db/cowork.db.bak-YYYY-MM-DD-HHMM cockpit/db/cowork.db
# Restart the service. Re-run `npm run db:generate`/`prisma db push` if the
# schema version changed between backup and restore.
```

---

## 4. Safe-deploy checklist

- [ ] Services bound to `127.0.0.1` (Cockpit: `next dev/start -H 127.0.0.1`; events service bound locally). No `0.0.0.0` on public hosts.
- [ ] `COWORK_UI_TOKEN` is set and **differs** from `COWORK_EVENT_TOKEN`.
- [ ] `NEXT_PUBLIC_COWORK_UI_TOKEN` (if used) is NOT equal to `COWORK_EVENT_TOKEN` on any untrusted network.
- [ ] `.env` files are not committed (gitignored) and have `0600` perms.
- [ ] Database backups exist (Section 3) before deploy.
- [ ] Cockpit builds clean (`cd cockpit && npm run build`); Prisma client generated (`npm run db:generate`); schema applied (`npx prisma db push`).
- [ ] Sub-package deps installed via `npm run bootstrap` on a fresh clone before `build:all`.

---

## 5. Health check

- **Cockpit** (Next.js, port 3000): `curl -fsS http://127.0.0.1:3000/ -o /dev/null && echo OK`
- **events mini-service** (port 3003): `curl -fsS http://127.0.0.1:3003/ -o /dev/null && echo OK`
  (adjust the path to the service's actual health endpoint if one is added).
- **Extension ↔ Cockpit**: open the side panel → "Open cockpit dashboard"; confirm a live connection and that no `COWORK_UI_TOKEN is unset` warning appears in the events service logs.

Alert if either health check fails for two consecutive intervals, or if a token
mismatch warning is logged by the events service.
