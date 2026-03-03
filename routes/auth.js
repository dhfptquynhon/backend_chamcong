const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../models/db');

// Đăng ký nhân viên mới
router.post('/register', async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien, password } = req.body;
  
  try {
    // Kiểm tra nhân viên đã tồn tại chưa
    const [existing] = await db.query('SELECT * FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Mã nhân viên đã tồn tại' });
    }

    // Mã hóa mật khẩu
    const hashedPassword = await bcrypt.hash(password, 10);

    // Tạo nhân viên mới
    await db.query(
      'INSERT INTO nhanvien (ma_nhan_vien, ten_nhan_vien, password) VALUES (?, ?, ?)',
      [ma_nhan_vien, ten_nhan_vien, hashedPassword]
    );

    res.status(201).json({ message: 'Đăng ký thành công' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// Đăng nhập
router.post('/login', async (req, res) => {
  const { ma_nhan_vien, password } = req.body;

  try {
    // Tìm nhân viên
    const [results] = await db.query('SELECT * FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (results.length === 0) {
      return res.status(401).json({ message: 'Mã nhân viên hoặc mật khẩu không đúng' });
    }

    const employee = results[0];

    // So sánh mật khẩu
    const isMatch = await bcrypt.compare(password, employee.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Mã nhân viên hoặc mật khẩu không đúng' });
    }

    // Tạo token JWT
    const token = jwt.sign(
      { id: employee.id, ma_nhan_vien: employee.ma_nhan_vien },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ 
      token,
      employee: {
        id: employee.id,
        ma_nhan_vien: employee.ma_nhan_vien,
        ten_nhan_vien: employee.ten_nhan_vien,
        is_admin: employee.is_admin === 1 || employee.is_admin === true
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// Quên mật khẩu - đổi mật khẩu mới bằng mật khẩu mặc định
router.post('/forgot-password', async (req, res) => {
  console.log('Forgot password endpoint called');
  console.log('Request body:', req.body);
  
  const { ma_nhan_vien, default_password, new_password } = req.body;
  const DEFAULT_PASSWORD = '123@123a';

  try {
    // Kiểm tra dữ liệu đầu vào
    if (!ma_nhan_vien || !default_password || !new_password) {
      return res.status(400).json({ message: 'Vui lòng điền đầy đủ thông tin' });
    }

    // Kiểm tra mật khẩu mặc định
    if (default_password !== DEFAULT_PASSWORD) {
      return res.status(401).json({ message: 'Mật khẩu mặc định không đúng' });
    }

    // Tìm nhân viên
    const [results] = await db.query('SELECT * FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (results.length === 0) {
      return res.status(404).json({ message: 'Mã nhân viên không tồn tại' });
    }

    // Mã hóa mật khẩu mới
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Cập nhật mật khẩu mới
    await db.query(
      'UPDATE nhanvien SET password = ? WHERE ma_nhan_vien = ?',
      [hashedPassword, ma_nhan_vien]
    );

    res.json({ message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập với mật khẩu mới.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;