import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, real, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import type { Slide } from '@/lib/slides';

export const carousels = pgTable('carousels', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  tipNumber: integer('tip_number'),
  status: text('status', { enum: ['draft', 'review', 'approved', 'posted'] }).notNull().default('draft'),
  currentVersion: integer('current_version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const versions = pgTable('versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  carouselId: uuid('carousel_id').notNull().references(() => carousels.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  slides: jsonb('slides').$type<Slide[]>().notNull(),
  images: jsonb('images').$type<string[]>().notNull().default([]),
  createdBy: text('created_by').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('versions_carousel_number').on(t.carouselId, t.number)]);

// Everything a human asks for: a note pinned on a slide, a text edit request, or a brand-new carousel.
export const requests = pgTable('requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['note', 'new'] }).notNull(),
  carouselId: uuid('carousel_id').references(() => carousels.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number'),
  slideIndex: integer('slide_index'),
  x: real('x'),
  y: real('y'),
  text: text('text').notNull(),
  status: text('status', { enum: ['open', 'claimed', 'done', 'dismissed'] }).notNull().default('open'),
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  reply: text('reply'),
  resultVersion: integer('result_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('requests_status').on(t.status), index('requests_carousel').on(t.carouselId)]);

// The active brand pack (colors, fonts, voice). Kept in the database so licensed fonts never enter the repo.
export const brand = pgTable('brand', {
  id: text('id').primaryKey(),
  pack: jsonb('pack').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  hash: text('hash').notNull().unique(),
  scopes: text('scopes').array().notNull().default(sql`'{read,write}'`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const activity = pgTable('activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  carouselId: uuid('carousel_id').references(() => carousels.id, { onDelete: 'set null' }),
  detail: jsonb('detail').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('activity_carousel_created').on(t.carouselId, t.createdAt)]);

// ---------- OAuth 2.1 (phase 2): web agents (ChatGPT, Claude.ai, Gemini) connect by URL ----------
// Every secret (code, token, client secret) is stored as a sha256 hash only.

export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull().unique(),
  secretHash: text('secret_hash'),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  tokenAuthMethod: text('token_auth_method', { enum: ['none', 'client_secret_post', 'client_secret_basic'] }).notNull().default('none'),
  logoUri: text('logo_uri'),
  clientUri: text('client_uri'),
  source: text('source', { enum: ['dcr', 'cimd'] }).notNull(),
  metadataFetchedAt: timestamp('metadata_fetched_at', { withTimezone: true }),
  /** DCR only: requester IP, for the 20-registrations-per-hour limit. */
  registeredIp: text('registered_ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scopes: text('scopes').array().notNull(),
  resource: text('resource').notNull(),
  /** Token family created when this code is exchanged; reuse of the code revokes the family. */
  familyId: uuid('family_id').notNull().defaultRandom(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('oauth_codes_expires').on(t.expiresAt)]);

export const oauthTokens = pgTable('oauth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull(),
  kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scopes: text('scopes').array().notNull(),
  resource: text('resource').notNull(),
  familyId: uuid('family_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, t => [index('oauth_tokens_family').on(t.familyId), index('oauth_tokens_client').on(t.clientId)]);
