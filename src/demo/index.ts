// Demo backend with sample data. Only bundled when built with VITE_DEMO=1
// (used to take README screenshots without a live database).
import docs from "./docs.json";
import type { ProfileView } from "../api";

const now = Date.now();
const base = {
  authSource: "", authMechanism: "", awsProfile: "", confirmProdWrites: true, defaultDatabase: "deliveries", hasPassword: true,
};

const profiles: ProfileView[] = [
  { ...base, id: "p1", name: "prod-us-east", uri: "mongodb+srv://cluster0.example.mongodb.net/", auth: "aws", username: "", tag: "production", readOnly: true, lastUsed: now - 12 * 60000 },
  { ...base, id: "p2", name: "prod-ca-central", uri: "mongodb+srv://cluster1.example.mongodb.net/", auth: "password", username: "app_readonly", tag: "production", readOnly: true, lastUsed: now - 26 * 3600000 },
  { ...base, id: "p3", name: "qa", uri: "mongodb+srv://qa.example.mongodb.net/", auth: "password", username: "qa_admin", tag: "qa", readOnly: false, lastUsed: now - 3 * 60000 },
  { ...base, id: "p4", name: "dev", uri: "mongodb+srv://dev.example.mongodb.net/", auth: "aws", username: "", awsProfile: "dev", tag: "dev", readOnly: false, lastUsed: now - 3 * 86400000 },
  { ...base, id: "p5", name: "localhost", uri: "mongodb://localhost:27017", auth: "none", username: "", tag: "local", readOnly: false, hasPassword: false, lastUsed: now - 8 * 86400000 },
];

const server = { version: "8.0.4", topology: "Replica set atlas-qa-shard-0 · 3 nodes", latencyMs: 41 };
let openIds: string[] = (import.meta.env.VITE_DEMO_OPEN ?? "").split(",").filter(Boolean);

const handlers: Record<string, (args: any) => unknown> = {
  list_profiles: () => profiles,
  get_profile: ({ id }) => profiles.find((p) => p.id === id) ?? profiles[2],
  test_connection: () => ({ version: "8.0.4", topology: "Replica set atlas-qa-shard-0 · 3 nodes", latencyMs: 41 }),
  reconnect: () => server,
  open_connection: ({ id }) => {
    if (!openIds.includes(id)) openIds.push(id);
    return server;
  },
  close_connection: ({ id }) => {
    openIds = openIds.filter((i) => i !== id);
  },
  list_open_connections: () =>
    openIds.map((id) => ({ profile: profiles.find((p) => p.id === id)!, server: id === "p1" ? { ...server, topology: "Replica set atlas-prod-shard-0 · 3 nodes" } : server })),
  list_databases: () => [
    { name: "admin", sizeOnDisk: 352256 },
    { name: "billing", sizeOnDisk: 912_000_000 },
    { name: "deliveries", sizeOnDisk: 3_100_000_000 },
    { name: "notifications", sizeOnDisk: 64_000_000 },
  ],
  list_collections: ({ db }) =>
    db === "deliveries"
      ? ["drivers", "events", "orders", "routes", "tenants", "zip_timezones"].map((name) => ({ name, kind: "collection" })).concat([{ name: "late_orders", kind: "view" }])
      : [{ name: "items", kind: "collection" }],
  find: () => ({ docs, elapsedMs: 18, skip: 0, hasMore: true }),
  count_documents: () => 1284,
  format_document: ({ text }) => text,
};

export async function demoInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 60));
  const h = handlers[cmd];
  return (h ? h(args) : undefined) as T;
}
