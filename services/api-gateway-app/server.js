import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 3000;

// En K8s, ces URLs seront les noms de service DNS interne
const INVENTORY_URL = process.env.INVENTORY_URL || "http://inventory:8080";
const BILLING_URL   = process.env.BILLING_URL   || "http://billing:8080";

app.get("/health", (_req, res) => res.send("ok"));

// Routes proxy
app.use("/inventory", createProxyMiddleware({ target: INVENTORY_URL, changeOrigin: true, pathRewrite: { "^/inventory": "" } }));
app.use("/billing",   createProxyMiddleware({ target: BILLING_URL,   changeOrigin: true, pathRewrite: { "^/billing": "" } }));

app.listen(PORT, () => console.log(`api-gateway on ${PORT} → inv=${INVENTORY_URL} bill=${BILLING_URL}`));
