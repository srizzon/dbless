# how dbless works

> same `DATABASE_URL` in every worktree. different physical database underneath.

---

## the trick

```
worktree feat-a              worktree feat-b              worktree feat-c
─────────────────            ─────────────────            ─────────────────
DATABASE_URL=                DATABASE_URL=                DATABASE_URL=
…/myapp?…worktree=feat_a     …/myapp?…worktree=feat_b     …/myapp?…worktree=feat_c
       │                            │                            │
       └────────────────────────────┴────────────────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │   proxy on :7777        │
                       │   reads `worktree=…`    │
                       │   rewrites database     │
                       │   field of postgres     │
                       │   StartupMessage        │
                       └─────────────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │   postgres on :15432    │
                       └─────────────────────────┘
                                    │
        ┌───────────────────┬───────┴───────┬───────────────────┐
        ▼                   ▼               ▼                   ▼
 ┌──────────────┐   ┌──────────────┐ ┌──────────────┐   ┌──────────────┐
 │ template_    │   │ myapp__      │ │ myapp__      │   │ myapp__      │
 │ myapp        │   │ feat_a       │ │ feat_b       │   │ feat_c       │
 │ (read-only)  │   │ (clone)      │ │ (clone)      │   │ (clone)      │
 └──────────────┘   └──────────────┘ └──────────────┘   └──────────────┘
```

---

## same string, different database

```
$ cd worktrees/feat-a && echo $DATABASE_URL
postgres://dbless@localhost:7777/myapp?options=-c+dbless.worktree=feat_a
                              ▲                                       ▲
                              │                                       │
                              proxy port                          routing key

$ cd worktrees/feat-b && echo $DATABASE_URL
postgres://dbless@localhost:7777/myapp?options=-c+dbless.worktree=feat_b
```

---

## connect yourself

every worktree exposes the same connection. only the `worktree=…` value changes.

| field    | value                            |
| -------- | -------------------------------- |
| host     | `localhost`                      |
| port     | `7777`                           |
| user     | `dbless`                       |
| password | `dbless`                       |
| database | `<project>`                      |
| options  | `-c dbless.worktree=<id>`      |

### option 1 — GUI client  (recommended for live demos)

[TablePlus](https://tableplus.com), [DBeaver](https://dbeaver.io), Postico, DataGrip — any of them.

add **two connections**, identical except for the `options` field:

```
connection: feat-a                       connection: feat-b
─────────────────────                    ─────────────────────
options: -c dbless.worktree=feat_a     options: -c dbless.worktree=feat_b
```

open both side by side — you are looking at two different physical databases through one proxy port.

### option 2 — your own shell, via dbless

```
cd worktrees/feat-a
dbless run -- node -e '
  const pg = require("pg");
  const c = new pg.Client(process.env.DATABASE_URL);
  c.connect().then(() => c.query("SELECT current_database()"))
   .then(r => console.log(r.rows[0])).then(() => c.end());
'
```

### option 3 — install psql, then `dbless shell`

```
brew install libpq
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

cd worktrees/feat-a
dbless shell
```

---

## see the magic underneath

bypass the proxy. talk to raw postgres on `:15432`. ask it which databases exist.

```
$ dbless run -- node -e '
  const pg = require("pg");
  const c = new pg.Client({
    host: "localhost", port: 15432,
    user: "dbless", password: "dbless", database: "postgres"
  });
  c.connect().then(() => c.query(
    "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
    ["myapp%"]
  )).then(r => r.rows.forEach(x => console.log(x.datname))).then(() => c.end());
'

template_myapp        ← source of truth, read-only
myapp__feat_a         ← cloned for feat-a (copy-on-write, sub-second)
myapp__feat_b         ← cloned for feat-b
myapp__feat_c         ← cloned for feat-c
```

three real, separate databases. the proxy on `:7777` is just routing.

---

## live demo recipe

```
┌─ pane 1 ──────────────────────────┐  ┌─ pane 2 ──────────────────────────┐
│ cd worktrees/feat-a               │  │ cd worktrees/feat-b               │
│                                   │  │                                   │
│ # in a GUI, pick connection       │  │ # in a GUI, pick connection       │
│ # "feat-a"                        │  │ # "feat-b"                        │
│                                   │  │                                   │
│ SELECT * FROM users;              │  │ SELECT * FROM users;              │
│ → alice, bob                      │  │ → alice, bob                      │
└───────────────────────────────────┘  └───────────────────────────────────┘

       both panes show the same DATABASE_URL string ☝︎ same data ☝︎


┌─ pane 1 ──────────────────────────┐  ┌─ pane 2 ──────────────────────────┐
│ INSERT INTO users (email)         │  │                                   │
│   VALUES ('charlie@x.com');       │  │ SELECT * FROM users;              │
│                                   │  │ → alice, bob                      │
│ DELETE FROM users;                │  │   ↑ unchanged                     │
└───────────────────────────────────┘  └───────────────────────────────────┘
```

same SQL, same proxy port, same connection string. **different physical database.**

---

## the moving parts

```
~/.dbless/
├── pgdata/             postgres cluster on :15432
├── postgres.pid        daemon state
├── proxy.pid
└── logs/

bin/dbless            CLI entry point
src/
  daemon.ts             parent of postgres + proxy
  proxy.ts              ~185 lines.  parses StartupMessage, rewrites
                        database field, then becomes a transparent pipe
  template.ts           CREATE DATABASE … TEMPLATE template_<project>
  worktree.ts           git rev-parse → safe id
```

```
your app                    ▶ talks to :7777, sees "myapp"
proxy (:7777)               ▶ reads worktree=… , rewrites to myapp__<id>
postgres (:15432)           ▶ has template_myapp  +  myapp__<id> per worktree
```

that's it.
