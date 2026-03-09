require('dotenv').config();
process.env.TZ = 'Asia/Ho_Chi_Minh';

const express = require('express');
const cors = require('cors'); // chỉ một lần

const app = express();
const PORT = process.env.PORT || 5000;

// ================= CORS CONFIG =================
const allowedOrigins = [
  'http://localhost:3000',
  'https://frontend-chamcong.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    // Cho phép request không có origin (ví dụ Postman, mobile app) hoặc nếu origin nằm trong danh sách
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true // nếu có gửi cookie/kèm auth
}));

// ================= MIDDLEWARE =================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= TEST ROUTE =================
app.get('/', (req, res) => {
  res.send('Backend chamcong đang chạy 🚀');
});

// ================= DATABASE =================
const db = require('./models/db');

// Test DB route
app.get('/api/test-db', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 as test');
    res.json({
      success: true,
      message: "Database connected",
      data: rows
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ================= ROUTES =================
const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);

// ================= 404 HANDLER =================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route không tồn tại"
  });
});

// ================= ERROR HANDLER =================
app.use((err, req, res, next) => {
  console.error("Server Error:", err);

  res.status(500).json({
    success: false,
    message: "Lỗi server",
    error: err.message
  });
});

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});