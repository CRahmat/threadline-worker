import { PrismaClient } from "@prisma/client";

export function hasDatabaseConfig() {
  return Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("USER:PASSWORD@HOST"));
}

function getDatasourceUrl() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString || !hasDatabaseConfig()) return undefined;

  try {
    const url = new URL(connectionString);
    // Serverless functions open short-lived connections. Supabase recommends
    // its transaction pooler (6543) for this workload; pgbouncer disables
    // prepared statements that are incompatible with transaction pooling.
    if (url.hostname.endsWith(".pooler.supabase.com")) {
      if (url.port === "5432") url.port = "6543";
      if (url.port === "6543" && !url.searchParams.has("pgbouncer")) url.searchParams.set("pgbouncer", "true");
      if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "3");
      if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "10");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const datasourceUrl = getDatasourceUrl() ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder";
export const db = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  datasourceUrl
});
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
