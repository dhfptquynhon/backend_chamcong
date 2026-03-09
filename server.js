require('dotenv').config();
process.env.TZ = 'Asia/Ho_Chi_Minh';

const express = require('express');
const app = express();
const PORT = process.env.PORT || 5000;

// ================= CORS CONFIG (TỰ VIẾT) =================
const allowedOrigins = [
  'http://localhost:3000',
  'https://frontend-chamcong.vercel.app'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Xử lý preflight request
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ================= MIDDLEWARE =================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= ROUTES =================
const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);

// ================= TEST ROUTES =================
app.get('/', (req, res) => {
  res.send('Backend chamcong đang chạy 🚀');
});

app.get('/api/cors-test', (req, res) => {
  res.json({ message: 'CORS is working!' });
});

// ================= DATABASE =================
const db = require('./models/db');

app.get('/api/test-db', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 as test');
    res.json({ success: true, message: "Database connected", data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 404 HANDLER =================
app.use((req, res) => {
  res.status(404).json({ success: false, message: "API route không tồn tại" });
});

// ================= ERROR HANDLER =================
app.use((err, req, res, next) => {
  console.error("Server Error:", err);
  res.status(500).json({ success: false, message: "Lỗi server", error: err.message });
});

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});