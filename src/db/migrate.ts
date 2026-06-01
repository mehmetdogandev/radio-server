import type Database from 'better-sqlite3';

/** SQLite 3 uyumlu bootstrap (Drizzle şeması ile aynı isimler). */
export function runBootstrapSql(sqlite: Database.Database): void {
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      is_group INTEGER NOT NULL DEFAULT 1,
      chat_type TEXT NOT NULL DEFAULT 'chat' CHECK (chat_type IN ('chat','voice')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER,
      deleted_at INTEGER,
      created_by INTEGER REFERENCES user(id)
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      user_id INTEGER NOT NULL REFERENCES user(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','removed')),
      removed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE TABLE IF NOT EXISTS chat_join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      user_id INTEGER NOT NULL REFERENCES user(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      sender_id INTEGER NOT NULL REFERENCES user(id),
      content TEXT,
      client_msg_id TEXT UNIQUE,
      seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq);
  `);
}

/** Migration v2: Add group invitations, admin roles, and additional indexes */
export function runMigrationV2(sqlite: Database.Database): void {
  // Check if migration already applied
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='group_invitations'").all();
  if (tables.length > 0) {
    console.log('Migration v2 already applied, skipping...');
    return;
  }

  sqlite.exec(`
    -- Add is_admin column to chat_members
    ALTER TABLE chat_members ADD COLUMN is_admin INTEGER DEFAULT 0;
    
    -- Create group_invitations table
    CREATE TABLE IF NOT EXISTS group_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      inviter_id INTEGER NOT NULL REFERENCES user(id),
      invitee_id INTEGER NOT NULL REFERENCES user(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      responded_at INTEGER
    );
    
    -- Add indexes for performance
    CREATE INDEX IF NOT EXISTS idx_invitations_invitee ON group_invitations(invitee_id, status);
    CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members(chat_id);
  `);
  
  console.log('Migration v2 applied successfully');
}

/** Migration v3: Voice groups + sessions + presence + speaker lock */
export function runMigrationV3(sqlite: Database.Database): void {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voice_groups'")
    .all();
  if (tables.length > 0) {
    console.log('Migration v3 already applied, skipping...');
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS voice_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES user(id),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS voice_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voice_group_id INTEGER NOT NULL REFERENCES voice_groups(id) ON DELETE CASCADE,
      active_speaker_admin_id INTEGER REFERENCES user(id),
      ptt_mode TEXT NOT NULL DEFAULT 'toggle' CHECK (ptt_mode IN ('toggle')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS voice_presence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voice_group_id INTEGER NOT NULL REFERENCES voice_groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES user(id),
      role TEXT NOT NULL DEFAULT 'listener' CHECK (role IN ('listener','speaker','admin')),
      joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS voice_speaker_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voice_group_id INTEGER NOT NULL REFERENCES voice_groups(id) ON DELETE CASCADE,
      locked_by_admin_id INTEGER NOT NULL REFERENCES user(id),
      locked_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_voice_groups_created_by ON voice_groups(created_by);
    CREATE INDEX IF NOT EXISTS idx_voice_presence_group ON voice_presence(voice_group_id);
    CREATE INDEX IF NOT EXISTS idx_voice_presence_user ON voice_presence(user_id);
    CREATE INDEX IF NOT EXISTS idx_voice_locks_group ON voice_speaker_locks(voice_group_id);
  `);

  console.log('Migration v3 applied successfully');
}
