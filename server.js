require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test route (để tránh Cannot GET /)
app.get('/', (req, res) => {
  res.send('Backend chamcong đang chạy 🚀');
});

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE
});

db.connect(err => {
  if (err) {
    console.error('❌ Error connecting to MySQL:', err);
  } else {
    console.log('✅ Connected to MySQL database');
  }
});

// Routes
const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);

// Start server (CHỈ 1 lần)
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});