import { pgTable, uuid, text, integer, real, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import type { Slide } from '@/lib/slides';

export const carousels = pgTable('carousels', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  tipNumber: integer('tip_number'),
  status: text('status', { enum: ['draft', 'review', 'approved', 'posted'] }).notNull().default('draft'),
  currentVersion: integer('current_version').notNull().default(1),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});
