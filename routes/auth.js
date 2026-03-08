// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../models/db');

// Đăng nhập
router.post('/login', async (req, res) => {
  try {
    const { ma_nhan_vien, mat_khau } = req.body;

    if (!ma_nhan_vien || !mat_khau) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập mã nhân viên và mật khẩu'
      });
    }

    const [employees] = await db.query(
      'SELECT * FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );

    if (employees.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Mã nhân viên hoặc mật khẩu không đúng'
      });
    }

    const employee = employees[0];

    const isMatch = await bcrypt.compare(mat_khau, employee.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Mã nhân viên hoặc mật khẩu không đúng'
      });
    }

    const token = jwt.sign(
      {
        id: employee.id,
        ma_nhan_vien: employee.ma_nhan_vien,
        ten_nhan_vien: employee.ten_nhan_vien
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      token,
      employee: {
        id: employee.id,
        ma_nhan_vien: employee.ma_nhan_vien,
        ten_nhan_vien: employee.ten_nhan_vien,
        is_admin: employee.is_admin === 1 || employee.is_admin === true
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Lỗi server, vui lòng thử lại sau'
    });
  }
});

// Đăng ký (chỉ admin mới được dùng)
router.post('/register', async (req, res) => {
  try {
    const { ma_nhan_vien, ten_nhan_vien, password, is_admin } = req.body;

    // Kiểm tra đầu vào
    if (!ma_nhan_vien || !ten_nhan_vien || !password) {
      return res.status(400).json({ 
        success: false,
        message: 'Vui lòng điền đầy đủ thông tin' 
      });
    }

    // Kiểm tra nhân viên đã tồn tại chưa
    const [existing] = await db.query(
      'SELECT id FROM nhanvien WHERE ma_nhan_vien = ?', 
      [ma_nhan_vien]
    );

    if (existing.length > 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Mã nhân viên đã tồn tại' 
      });
    }

    // Mã hóa mật khẩu
    const hashedPassword = await bcrypt.hash(password, 10);

    // Tạo nhân viên mới
    await db.query(
      'INSERT INTO nhanvien (ma_nhan_vien, ten_nhan_vien, password, is_admin) VALUES (?, ?, ?, ?)',
      [ma_nhan_vien, ten_nhan_vien, hashedPassword, is_admin ? 1 : 0]
    );

    res.status(201).json({ 
      success: true,
      message: 'Đăng ký thành công' 
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server, vui lòng thử lại sau' 
    });
  }
});

// Lấy thông tin user hiện tại (dùng để kiểm tra token)
router.get('/me', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        success: false,
        message: 'Không tìm thấy token' 
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    
    const [employees] = await db.query(
      'SELECT id, ma_nhan_vien, ten_nhan_vien, is_admin FROM nhanvien WHERE ma_nhan_vien = ?',
      [decoded.ma_nhan_vien]
    );

    if (employees.length === 0) {
      return res.status(401).json({ 
        success: false,
        message: 'Không tìm thấy thông tin người dùng' 
      });
    }

    res.json({ 
      success: true,
      employee: employees[0]
    });

  } catch (error) {
    console.error('Get me error:', error);
    res.status(401).json({ 
      success: false,
      message: 'Token không hợp lệ' 
    });
  }
});

module.exports = router;