// middleware/auth.js
const jwt = require('jsonwebtoken');
const db = require('../models/db');

/**
 * Middleware xác thực JWT token
 * Kiểm tra token từ header Authorization, verify và lấy thông tin user từ database
 */
const auth = async (req, res, next) => {
  try {
    // 1. Kiểm tra header Authorization có tồn tại không
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return res.status(401).json({ 
        success: false,
        message: 'Không tìm thấy token xác thực. Vui lòng đăng nhập.' 
      });
    }

    // 2. Kiểm tra format token (phải là Bearer token)
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false,
        message: 'Token không đúng định dạng. Vui lòng đăng nhập lại.' 
      });
    }

    // 3. Lấy token từ header (loại bỏ "Bearer ")
    const token = authHeader.substring(7); // hoặc authHeader.replace('Bearer ', '')
    
    if (!token || token.trim() === '') {
      return res.status(401).json({ 
        success: false,
        message: 'Token không hợp lệ. Vui lòng đăng nhập lại.' 
      });
    }

    // 4. Verify token với JWT_SECRET
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          success: false,
          message: 'Token đã hết hạn. Vui lòng đăng nhập lại.',
          expired: true
        });
      }
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          success: false,
          message: 'Token không hợp lệ. Vui lòng đăng nhập lại.' 
        });
      }
      throw jwtError;
    }

    // 5. Kiểm tra payload có chứa ma_nhan_vien không
    if (!decoded || !decoded.ma_nhan_vien) {
      return res.status(401).json({ 
        success: false,
        message: 'Token không chứa thông tin nhân viên. Vui lòng đăng nhập lại.' 
      });
    }

    // 6. Query database để lấy thông tin nhân viên đầy đủ
    const [employees] = await db.query(
      'SELECT id, ma_nhan_vien, ten_nhan_vien, is_admin FROM nhanvien WHERE ma_nhan_vien = ?',
      [decoded.ma_nhan_vien]
    );

    // 7. Kiểm tra nhân viên có tồn tại trong database không
    if (!employees || employees.length === 0) {
      return res.status(401).json({ 
        success: false,
        message: 'Tài khoản không tồn tại trong hệ thống.' 
      });
    }

    const employee = employees[0];

    // 8. Gán thông tin nhân viên vào req.employee để sử dụng ở các route tiếp theo
    req.employee = {
      id: employee.id,
      ma_nhan_vien: employee.ma_nhan_vien,
      ten_nhan_vien: employee.ten_nhan_vien,
      is_admin: employee.is_admin === 1 || employee.is_admin === true
    };
    
    // 9. Gán token vào req để có thể sử dụng nếu cần
    req.token = token;

    // 10. Log để debug (có thể xóa ở môi trường production)
    console.log(`✅ Auth thành công: ${employee.ma_nhan_vien} - ${employee.ten_nhan_vien} - ${employee.is_admin ? 'Admin' : 'User'}`);

    // 11. Chuyển sang middleware/route tiếp theo
    next();

  } catch (error) {
    // Xử lý các lỗi không mong đợi
    console.error('❌ Auth middleware error:', error);
    
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server trong quá trình xác thực. Vui lòng thử lại sau.' 
    });
  }
};

module.exports = auth;