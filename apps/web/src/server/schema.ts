import {
  pgSchema,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import type { WorkContent, Scope } from "../shared/contracts";
export const appSchema = pgSchema("musecity");
const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" }).notNull().defaultNow();
export const accounts = appSchema.table("accounts", {
  id: text().primaryKey(),
  website_marker: text().notNull().unique(),
  privy_user_id: text().notNull().unique(),
  handle: text().notNull().unique(),
  name: text().notNull(),
  bio: text().notNull().default(""),
  avatar_media_id: text(),
  status: text().notNull().default("active"),
  // Retained historical values only; not exposed or used by the application.
  ecosystems: text().array().notNull().default([]),
  working_on: text().notNull().default(""),
  can_help: text().notNull().default(""),
  joined_at: timestamp({ withTimezone: true, mode: "date" }),
  created_at: time("created_at"),
});
export const tags = appSchema.table("tags", {
  id: text().primaryKey(),
  name: text().notNull(),
  enabled: boolean().notNull().default(true),
});
export const agents = appSchema.table("agents", {
  id: text().primaryKey(),
  website_marker: text().notNull().unique(),
  owner_account_id: text()
    .notNull()
    .references(() => accounts.id),
  name: text().notNull(),
  scopes: jsonb().$type<Scope[]>().notNull(),
  status: text().notNull().default("active"),
  created_at: time("created_at"),
  last_active_at: timestamp({ withTimezone: true, mode: "date" }),
  public_visible: boolean().notNull().default(false),
  description: text().notNull().default(""),
});
export const oauthClients = appSchema.table("oauth_clients", {
  id: text().primaryKey(),
  name: text().notNull(),
  redirect_uris: jsonb().$type<string[]>().notNull(),
  created_at: time("created_at"),
});
export const oauthRequests = appSchema.table("oauth_requests", {
  id: text().primaryKey(),
  client_id: text()
    .notNull()
    .references(() => oauthClients.id),
  redirect_uri: text().notNull(),
  state: text(),
  resource: text().notNull(),
  code_challenge: text().notNull(),
  requested_scopes: jsonb().$type<Scope[]>().notNull(),
  owner_account_id: text().references(() => accounts.id, {
    onDelete: "cascade",
  }),
  name: text(),
  approved_scopes: jsonb().$type<Scope[]>(),
  status: text().notNull().default("pending"),
  code_hash: text().unique(),
  expires_at: time("expires_at"),
  created_at: time("created_at"),
});
export const oauthGrants = appSchema.table("oauth_grants", {
  id: text().primaryKey(),
  client_id: text()
    .notNull()
    .references(() => oauthClients.id),
  owner_account_id: text()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  agent_id: text()
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  resource: text().notNull(),
  scopes: jsonb().$type<Scope[]>().notNull(),
  version: integer().notNull().default(1),
  expires_at: time("expires_at"),
  revoked_at: timestamp({ withTimezone: true, mode: "date" }),
  connected_at: timestamp({ withTimezone: true, mode: "date" }),
});
export const oauthRefreshTokens = appSchema.table("oauth_refresh_tokens", {
  id: text().primaryKey(),
  grant_id: text()
    .notNull()
    .references(() => oauthGrants.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  token_hash: text().notNull().unique(),
  scopes: jsonb().$type<Scope[]>().notNull(),
  expires_at: time("expires_at"),
  used_at: timestamp({ withTimezone: true, mode: "date" }),
});
export const credentials = appSchema.table("credentials", {
  id: text().primaryKey(),
  agent_id: text()
    .notNull()
    .references(() => agents.id),
  token_hash: text().notNull().unique(),
  prefix: text().notNull(),
  oauth_grant_id: text().references(() => oauthGrants.id, {
    onDelete: "cascade",
  }),
  oauth_version: integer(),
  oauth_scopes: jsonb().$type<Scope[]>(),
  expires_at: time("expires_at"),
  revoked_at: timestamp({ withTimezone: true, mode: "date" }),
  created_at: time("created_at"),
});
export const works = appSchema.table("works", {
  id: text().primaryKey(),
  owner_account_id: text()
    .notNull()
    .references(() => accounts.id),
  created_by_agent_id: text().references(() => agents.id),
  published_by_agent_id: text().references(() => agents.id),
  status: text().notNull().default("draft"),
  blocked: boolean().notNull().default(false),
  draft_revision_id: text(),
  published_revision_id: text(),
  published_at: timestamp({ withTimezone: true, mode: "date" }),
  first_published_at: timestamp({ withTimezone: true, mode: "date" }),
  created_at: time("created_at"),
  updated_at: time("updated_at"),
});
export const revisions = appSchema.table("work_revisions", {
  id: text().primaryKey(),
  work_id: text()
    .notNull()
    .references(() => works.id),
  payload: jsonb().$type<WorkContent>().notNull(),
  tag_ids: text().array().notNull(),
  media_ids: text().array().notNull(),
  editor_agent_id: text().references(() => agents.id),
  created_at: time("created_at"),
});
export const media = appSchema.table("media", {
  id: text().primaryKey(),
  owner_account_id: text()
    .notNull()
    .references(() => accounts.id),
  agent_id: text().references(() => agents.id),
  object_key: text().notNull(),
  mime_type: text().notNull(),
  byte_size: integer().notNull(),
  purpose: text().notNull().default("content"),
  width: integer(),
  height: integer(),
  status: text().notNull().default("uploading"),
  upload_hash: text().notNull(),
  expires_at: time("expires_at"),
  etag: text(),
  created_at: time("created_at"),
});
export type AccountRow = typeof accounts.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type WorkRow = typeof works.$inferSelect;
export type RevisionRow = typeof revisions.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
