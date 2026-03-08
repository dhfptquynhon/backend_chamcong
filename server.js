require('dotenv').config();
process.env.TZ = 'Asia/Ho_Chi_Minh';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test route
app.get('/', (req, res) => {
  res.send('Backend chamcong đang chạy 🚀');
});

// IMPORT DB (dùng db.js)
const db = require('./models/db');

// Routes
const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});