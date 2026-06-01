import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'number' }),
});

export const chats = sqliteTable('chats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name'),
  isGroup: integer('is_group', { mode: 'boolean' }).notNull().default(true),
  chatType: text('chat_type', { enum: ['chat', 'voice'] }).notNull().default('chat'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }),
  deletedAt: integer('deleted_at', { mode: 'number' }),
  createdBy: integer('created_by').references(() => users.id),
});

export const chatMembers = sqliteTable('chat_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id')
    .notNull()
    .references(() => chats.id),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  status: text('status', { enum: ['pending', 'active', 'removed'] }).notNull().default('active'),
  removedAt: integer('removed_at', { mode: 'number' }),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
});

export const chatJoinRequests = sqliteTable('chat_join_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id')
    .notNull()
    .references(() => chats.id),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id')
    .notNull()
    .references(() => chats.id),
  senderId: integer('sender_id')
    .notNull()
    .references(() => users.id),
  content: text('content'),
  clientMsgId: text('client_msg_id').unique(),
  seq: integer('seq').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
});

export const groupInvitations = sqliteTable('group_invitations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id')
    .notNull()
    .references(() => chats.id),
  inviterId: integer('inviter_id')
    .notNull()
    .references(() => users.id),
  inviteeId: integer('invitee_id')
    .notNull()
    .references(() => users.id),
  status: text('status', { enum: ['pending', 'accepted', 'declined'] }).notNull().default('pending'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  respondedAt: integer('responded_at', { mode: 'number' }),
});

export const voiceGroups = sqliteTable('voice_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'number' }),
});

export const voiceSessions = sqliteTable('voice_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceGroupId: integer('voice_group_id')
    .notNull()
    .references(() => voiceGroups.id),
  activeSpeakerAdminId: integer('active_speaker_admin_id').references(() => users.id),
  pttMode: text('ptt_mode', { enum: ['toggle'] }).notNull().default('toggle'),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
});

export const voicePresence = sqliteTable('voice_presence', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceGroupId: integer('voice_group_id')
    .notNull()
    .references(() => voiceGroups.id),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  role: text('role', { enum: ['listener', 'speaker', 'admin'] }).notNull().default('listener'),
  joinedAt: integer('joined_at', { mode: 'number' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'number' }).notNull(),
});

export const voiceSpeakerLocks = sqliteTable('voice_speaker_locks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceGroupId: integer('voice_group_id')
    .notNull()
    .references(() => voiceGroups.id),
  lockedByAdminId: integer('locked_by_admin_id')
    .notNull()
    .references(() => users.id),
  lockedAt: integer('locked_at', { mode: 'number' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
});
