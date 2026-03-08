const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
});

console.log("DB HOST:", process.env.MYSQLHOST);
console.log("DB USER:", process.env.MYSQLUSER);
console.log("DB DATABASE:", process.env.MYSQLDATABASE);
console.log("DB PORT:", process.env.MYSQLPORT);

module.exports = pool;