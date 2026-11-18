import mysql from 'mysql2/promise';

export async function connectMySql() {
  const { MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE } = process.env;
  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE) {
    throw new Error('MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE are required in server/.env.');
  }

  const pool = mysql.createPool({
    host: MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || '',
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    charset: 'utf8mb4'
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_state (
        state_key VARCHAR(64) NOT NULL PRIMARY KEY,
        state_value LONGTEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
        email VARCHAR(320) NOT NULL UNIQUE,
        account_type VARCHAR(32) NOT NULL,
        role_code VARCHAR(64) NOT NULL DEFAULT '',
        role_name VARCHAR(255) NOT NULL DEFAULT '',
        office VARCHAR(255) NOT NULL DEFAULT '',
        password_hash VARCHAR(256) NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        must_change_password TINYINT(1) NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS procurement_records (
        collection_name VARCHAR(64) NOT NULL,
        record_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        position BIGINT NOT NULL DEFAULT 0,
        record_json LONGTEXT NOT NULL,
        PRIMARY KEY (collection_name, record_id),
        KEY ix_procurement_records_position (collection_name, position)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS uploads (
        file_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
        content_type VARCHAR(255) NOT NULL,
        data LONGBLOB NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
