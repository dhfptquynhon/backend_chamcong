const mysql = require('mysql2/promise');

// Log env để debug Railway
console.log("DB HOST:", process.env.DB_HOST);
console.log("DB USER:", process.env.DB_USER);
console.log("DB DATABASE:", process.env.DB_DATABASE);
console.log("DB PORT:", process.env.DB_PORT);

// Tạo pool trước
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test connection
pool.getConnection()
  .then(conn => {
    console.log("✅ Connected to MySQL");
    conn.release();
  })
  .catch(err => {
    console.error("❌ MySQL connection failed:", err);
  });

module.exports = pool;