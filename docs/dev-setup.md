# Dev Setup (Milestone 1)

## Local Postgres

Option A: Docker

```bash
docker run --name agent-hub-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=agent_hub \
  -p 5432:5432 \
  -d postgres:16
```

Export the connection string in your shell:

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agent_hub"
```

## Apply migrations

Run migrations in order:

```bash
for file in packages/db/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$file"
done
```

Notes:
- Migrations are plain SQL files in `packages/db/migrations`.
- Apply them in filename order.
