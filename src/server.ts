import { createServer } from "node:http";
import { db } from "../lib/db.js";
import { handleGet, handlePost } from "./worker.js";

const port = Number(process.env.PORT || 3000);
const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`);
  if (url.pathname === "/healthz" && incoming.method === "GET") {
    outgoing.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname !== "/api/cron/post-worker" || !["GET", "POST"].includes(incoming.method || "")) {
    outgoing.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = new Request(url, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {})
  });
  try {
    const response = incoming.method === "GET" ? await handleGet(request) : await handlePost(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Worker request failed", error);
    outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(port, "0.0.0.0", () => console.info(`Threadline worker listening on ${port}`));
async function shutdown() {
  server.close(async () => { await db.$disconnect(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
