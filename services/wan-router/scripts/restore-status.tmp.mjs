import { existsSync, writeFileSync } from "node:fs";
import pg from "pg";
const { Pool } = pg;
const output = [];
const pool = new Pool({
  connectionString: "postgres://wan_router:wan_router_dev@127.0.0.1:55432/wan_router",
  connectionTimeoutMillis: 5_000,
  max: 1,
});
try {
  const result = await pool.query("select datname from pg_database where datname like 'wan_router_backup_%' order by datname");
  output.push(`script=${existsSync(new URL('./backup-restore-rehearsal.mjs', import.meta.url))}`);
  for (const { datname } of result.rows) {
    await pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [datname],
    );
    await pool.query(`drop database if exists "${datname}"`);
    output.push(`dropped=${datname}`);
  }
  if (!result.rows.length) output.push("temp-databases=none");
  writeFileSync("/tmp/wan-router-restore-status.log", `${output.join("\n")}\n`, "utf8");
} finally {
  await pool.end();
}
