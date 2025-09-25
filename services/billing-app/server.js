import express from "express";
import amqp from "amqplib";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 8080;

// DB billing
const DB_HOST = process.env.DB_HOST || "billing-db";
const DB_PORT = process.env.DB_PORT || "5432";
const DB_NAME = process.env.DB_NAME || "billing";
const DB_USER = process.env.DB_USER || "app_user";
const DB_PASS = process.env.DB_PASS || "change_me";

// RabbitMQ
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const QUEUE_NAME = process.env.QUEUE_NAME || "billing_queue";

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
async function startConsumer() {
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    const ch = await conn.createChannel();
    await ch.assertQueue(QUEUE_NAME, { durable: true });
    console.log("billing-app consuming queue:", QUEUE_NAME);
    ch.consume(QUEUE_NAME, async (msg) => {
      if (!msg) return;
      const content = msg.content.toString();
      console.log("consumed:", content);
      // TODO: write to DB (exemple)
      try {
        const p = getPool();
        await p.query("SELECT 1");
      } catch(e) {
        console.error("DB write failed:", e.message);
      }
      ch.ack(msg);
    });
  } catch (e) {
    console.warn("RabbitMQ not reachable yet:", e.message);
    // On n'échoue pas au démarrage; on pourra relancer plus tard si besoin.
  }
}

app.get("/health", (_req, res) => res.send("ok"));
app.get("/db-check", async (_req, res) => {
try {
const p = getPool();
const { rows } = await p.query("SELECT NOW() as now");
res.json({ status: "ok", now: rows[0].now });
} catch (e) {
res.status(500).json({ error: "DB not reachable", details: e.message });
}
});

app.listen(PORT, () => {
  console.log(`billing-app on ${PORT}`);
  startConsumer(); // non-bloquant
});
