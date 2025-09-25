import express from "express";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 8080;

// Vars DB (seront fournies via K8s/Secrets plus tard)
const DB_HOST = process.env.DB_HOST || "inventory-db";
const DB_PORT = process.env.DB_PORT || "5432";
const DB_NAME = process.env.DB_NAME || "inventory";
const DB_USER = process.env.DB_USER || "app_user";
const DB_PASS = process.env.DB_PASS || "change_me";

// Pool paresseux: on ne crashe pas si la DB n'est pas dispo
let pool = null;
function getPool() {
if (!pool) {
const DB_SSL = (process.env.DB_SSL || 'true').toLowerCase() !== 'false';
pool = new Pool({
host: DB_HOST,
port: DB_PORT,
database: DB_NAME,
user: DB_USER,
password: DB_PASS,
ssl: DB_SSL ? { rejectUnauthorized: false } : false
});
}
return pool;
}
app.get("/health", (req, res) => res.send("ok"));

app.get("/items", async (req, res) => {
  try {
    const p = getPool();
    const { rows } = await p.query("SELECT NOW() as now");
    res.json({ status: "ok", now: rows[0].now });
  } catch (e) {
    res.status(500).json({ error: "DB not reachable", details: e.message });
  }
});

app.listen(PORT, () => console.log(`inventory-app on ${PORT}`));
