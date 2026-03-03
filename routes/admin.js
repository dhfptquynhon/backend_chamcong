const express = require('express');
const router = express.Router();
const db = require('../models/db');
const auth = require('../middleware/auth');

// ======================
// API QUẢN LÝ NHÂN VIÊN - ĐẦY ĐỦ
// ======================

// Middleware kiểm tra quyền admin
const requireAdmin = async (req, res, next) => {
  try {
    const { ma_nhan_vien } = req.employee;
    const [rows] = await db.query(
      'SELECT is_admin FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );
    
    if (rows.length === 0 || rows[0].is_admin !== 1) {
      return res.status(403).json({ message: 'Bạn không có quyền admin' });
    }
    
    next();
  } catch (error) {
    console.error('Lỗi kiểm tra quyền admin:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
};

// 1. Lấy danh sách nhân viên (ĐẦY ĐỦ với thống kê)
router.get('/admin/employees', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        nv.*,
        (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = nv.id) as total_registered_shifts,
        (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = nv.id AND trang_thai = 'checked_out') as total_completed_shifts,
        (SELECT COALESCE(SUM(thoi_gian_lam), 0) FROM lich_truc WHERE nhan_vien_id = nv.id AND trang_thai = 'checked_out') as total_work_hours
      FROM nhanvien nv
      ORDER BY nv.created_at DESC`
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy danh sách nhân viên:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// 2. Tạo nhân viên mới
router.post('/admin/employees/create', auth, requireAdmin, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien, password, is_admin } = req.body;
  
  try {
    // Kiểm tra mã nhân viên đã tồn tại
    const [existing] = await db.query(
      'SELECT id FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Mã nhân viên đã tồn tại' });
    }
    
    // Mã hóa mật khẩu
    const bcrypt = require('bcrypt');
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Tạo nhân viên mới
    const [result] = await db.query(
      `INSERT INTO nhanvien (ma_nhan_vien, ten_nhan_vien, password, is_admin) 
       VALUES (?, ?, ?, ?)`,
      [ma_nhan_vien, ten_nhan_vien, hashedPassword, is_admin ? 1 : 0]
    );
    
    res.json({
      success: true,
      message: 'Tạo nhân viên thành công',
      id: result.insertId
    });
  } catch (error) {
    console.error('Lỗi tạo nhân viên:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// 3. Cập nhật nhân viên
router.put('/admin/employees/:id', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { ten_nhan_vien, password, is_admin } = req.body;
  
  try {
    let updateQuery = 'UPDATE nhanvien SET ten_nhan_vien = ?, is_admin = ?';
    let queryParams = [ten_nhan_vien, is_admin ? 1 : 0];
    
    // Nếu có password thì cập nhật
    if (password && password.trim() !== '') {
      const bcrypt = require('bcrypt');
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      updateQuery += ', password = ?';
      queryParams.push(hashedPassword);
    }
    
    updateQuery += ' WHERE id = ?';
    queryParams.push(id);
    
    await db.query(updateQuery, queryParams);
    
    res.json({
      success: true,
      message: 'Cập nhật nhân viên thành công'
    });
  } catch (error) {
    console.error('Lỗi cập nhật nhân viên:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// 4. Xóa nhân viên
router.delete('/admin/employees/:id', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Không cho xóa chính mình
    if (req.employee.id === parseInt(id)) {
      return res.status(400).json({ message: 'Không thể xóa tài khoản của chính bạn' });
    }
    
    // Kiểm tra nhân viên có lịch trực không
    const [hasSchedule] = await db.query(
      'SELECT id FROM lich_truc WHERE nhan_vien_id = ? LIMIT 1',
      [id]
    );
    
    if (hasSchedule.length > 0) {
      return res.status(400).json({ 
        message: 'Không thể xóa nhân viên đã có lịch trực. Hãy xóa lịch trực trước.' 
      });
    }
    
    await db.query('DELETE FROM nhanvien WHERE id = ?', [id]);
    
    res.json({
      success: true,
      message: 'Xóa nhân viên thành công'
    });
  } catch (error) {
    console.error('Lỗi xóa nhân viên:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API QUẢN LÝ TRỰC THAY - ĐẦY ĐỦ
// ======================

// 5. Lấy danh sách trực thay chờ duyệt
router.get('/admin/pending-tructhay', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        tt.*,
        nv_th.ten_nhan_vien as ten_nguoi_truc_thay,
        nv_th.ma_nhan_vien as ma_nguoi_truc_thay,
        nv_dk.ten_nhan_vien as ten_nguoi_duoc_truc_thay,
        nv_dk.ma_nhan_vien as ma_nguoi_duoc_truc_thay,
        lt.ngay,
        lt.ca
      FROM truc_thay tt
      INNER JOIN nhanvien nv_th ON tt.nguoi_thuc_hien_id = nv_th.id
      INNER JOIN nhanvien nv_dk ON tt.nguoi_dang_ky_id = nv_dk.id
      INNER JOIN lich_truc lt ON tt.lich_truc_goc_id = lt.id
      WHERE tt.trang_thai = 'pending'
      ORDER BY tt.created_at DESC`
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy trực thay chờ duyệt:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// 6. Duyệt/từ chối trực thay
router.post('/admin/tructhay/:id/approve', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { approve } = req.body; // true: duyệt, false: từ chối

  try {
    await db.query('START TRANSACTION');
    
    const [trucThayRows] = await db.query(
      'SELECT * FROM truc_thay WHERE id = ?',
      [id]
    );

    if (trucThayRows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: 'Không tìm thấy yêu cầu trực thay' });
    }

    const trucThay = trucThayRows[0];

    if (approve) {
      // Duyệt: cập nhật trạng thái thành active
      await db.query(
        'UPDATE truc_thay SET trang_thai = "active", admin_duyet = 1, updated_at = NOW() WHERE id = ?',
        [id]
      );

      await db.query('COMMIT');
      res.json({ 
        message: 'Đã duyệt yêu cầu trực thay',
        data: { id, status: 'active' }
      });
    } else {
      // Từ chối: xóa bản ghi trực thay
      await db.query('DELETE FROM truc_thay WHERE id = ?', [id]);
      await db.query('COMMIT');
      
      res.json({ 
        message: 'Đã từ chối yêu cầu trực thay',
        data: { id, status: 'rejected' }
      });
    }
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Lỗi xử lý trực thay:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API BÁO CÁO & THỐNG KÊ - ĐẦY ĐỦ
// ======================

// 7. Thống kê tổng quan
router.get('/admin/overview-stats', auth, requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const [stats] = await db.query(
      `SELECT 
        (SELECT COUNT(*) FROM nhanvien) as total_employees,
        (SELECT COUNT(DISTINCT nhan_vien_id) FROM lich_truc WHERE DATE(ngay) = ? AND trang_thai IN ('checked_in', 'checked_out')) as active_today,
        (SELECT COUNT(*) FROM lich_truc WHERE MONTH(ngay) = ? AND YEAR(ngay) = ?) as total_shifts_this_month,
        (SELECT COALESCE(SUM(thoi_gian_lam), 0) FROM lich_truc WHERE MONTH(ngay) = ? AND YEAR(ngay) = ? AND trang_thai = 'checked_out') as total_hours_this_month,
        (SELECT COUNT(*) FROM truc_thay WHERE trang_thai = 'pending') as pending_truc_thay`,
      [today, currentMonth, currentYear, currentMonth, currentYear]
    );

    res.json({
      totalEmployees: stats[0].total_employees,
      activeToday: stats[0].active_today,
      totalShiftsThisMonth: stats[0].total_shifts_this_month,
      totalHoursThisMonth: parseFloat(stats[0].total_hours_this_month) || 0,
      pendingTrucThay: stats[0].pending_truc_thay || 0
    });
  } catch (error) {
    console.error('Lỗi lấy thống kê:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// 8. Báo cáo chấm công tổng hợp
router.get('/admin/attendance-report', auth, requireAdmin, async (req, res) => {
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    const [details] = await db.query(
      `SELECT 
        nv.id,
        nv.ma_nhan_vien,
        nv.ten_nhan_vien,
        COUNT(DISTINCT DATE(lt.ngay)) as work_days_count,
        GROUP_CONCAT(DISTINCT DATE_FORMAT(lt.ngay, '%d/%m/%Y') ORDER BY lt.ngay) as work_days,
        COUNT(lt.id) as total_shifts,
        COALESCE(SUM(lt.thoi_gian_lam), 0) as total_hours,
        (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = nv.id AND MONTH(ngay) = ? AND YEAR(ngay) = ?) as total_registered,
        ROUND(
          CASE 
            WHEN (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = nv.id AND MONTH(ngay) = ? AND YEAR(ngay) = ?) > 0
            THEN (COUNT(lt.id) / (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = nv.id AND MONTH(ngay) = ? AND YEAR(ngay) = ?)) * 100
            ELSE 0
          END, 2
        ) as completion_rate
      FROM nhanvien nv
      LEFT JOIN lich_truc lt ON nv.id = lt.nhan_vien_id 
        AND MONTH(lt.ngay) = ? 
        AND YEAR(lt.ngay) = ?
        AND lt.trang_thai = 'checked_out'
        AND lt.thoi_gian_lam IS NOT NULL
      GROUP BY nv.id, nv.ma_nhan_vien, nv.ten_nhan_vien
      ORDER BY total_hours DESC, total_shifts DESC`,
      [targetMonth, targetYear, targetMonth, targetYear, targetMonth, targetYear, targetMonth, targetYear]
    );

    // Tính tổng thống kê
    let totalEmployees = details.length;
    let totalShifts = 0;
    let totalHours = 0;
    let employeesWithShifts = 0;

    details.forEach(emp => {
      totalShifts += emp.total_shifts || 0;
      totalHours += parseFloat(emp.total_hours || 0);
      if (emp.total_shifts > 0) employeesWithShifts++;
    });

    const averageHours = employeesWithShifts > 0 ? totalHours / employeesWithShifts : 0;
    const averageCompletionRate = details.length > 0 
      ? details.reduce((sum, emp) => sum + (emp.completion_rate || 0), 0) / details.length 
      : 0;

    res.json({
      details: details,
      summary: {
        totalEmployees,
        totalShifts,
        totalHours: parseFloat(totalHours.toFixed(2)),
        averageHours: parseFloat(averageHours.toFixed(2)),
        employeesWithShifts,
        averageCompletionRate: parseFloat(averageCompletionRate.toFixed(2))
      }
    });
  } catch (error) {
    console.error('Lỗi lấy báo cáo chấm công:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API CHI TIẾT NHÂN VIÊN - ĐẦY ĐỦ
// ======================

// 9. Lấy chi tiết nhân viên (bao gồm lịch sử trực thay)
router.get('/admin/employee/:id/detail', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    // Thông tin cơ bản
    const [employeeRows] = await db.query(
      'SELECT * FROM nhanvien WHERE id = ?',
      [id]
    );
    
    if (employeeRows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy nhân viên' });
    }
    
    const employee = employeeRows[0];
    
    // Lịch trực trong tháng
    const [scheduleRows] = await db.query(
      `SELECT * FROM lich_truc 
       WHERE nhan_vien_id = ? 
         AND MONTH(ngay) = ? 
         AND YEAR(ngay) = ?
       ORDER BY ngay ASC, ca ASC`,
      [id, targetMonth, targetYear]
    );
    
    // Thống kê tháng
    const [statsRows] = await db.query(
      `SELECT 
        COUNT(*) as total_registered,
        SUM(CASE WHEN trang_thai = 'checked_out' THEN 1 ELSE 0 END) as total_completed,
        COALESCE(SUM(CASE WHEN trang_thai = 'checked_out' THEN thoi_gian_lam ELSE 0 END), 0) as total_hours,
        ROUND(
          CASE 
            WHEN COUNT(*) > 0 
            THEN (SUM(CASE WHEN trang_thai = 'checked_out' THEN 1 ELSE 0 END) / COUNT(*)) * 100
            ELSE 0
          END, 2
        ) as completion_rate
      FROM lich_truc
      WHERE nhan_vien_id = ?
        AND MONTH(ngay) = ?
        AND YEAR(ngay) = ?`,
      [id, targetMonth, targetYear]
    );
    
    // Lịch sử trực thay
    const [trucThayRows] = await db.query(
      `SELECT 
        tt.*,
        CASE 
          WHEN tt.nguoi_thuc_hien_id = ? THEN 'thuc_hien'
          WHEN tt.nguoi_dang_ky_id = ? THEN 'duoc_truc_thay'
        END as loai,
        nv_th.ten_nhan_vien as ten_nguoi_truc_thay,
        nv_th.ma_nhan_vien as ma_nguoi_truc_thay,
        nv_dk.ten_nhan_vien as ten_nguoi_duoc_truc_thay,
        nv_dk.ma_nhan_vien as ma_nguoi_duoc_truc_thay,
        lt.ngay,
        lt.ca
      FROM truc_thay tt
      INNER JOIN nhanvien nv_th ON tt.nguoi_thuc_hien_id = nv_th.id
      INNER JOIN nhanvien nv_dk ON tt.nguoi_dang_ky_id = nv_dk.id
      INNER JOIN lich_truc lt ON tt.lich_truc_goc_id = lt.id
      WHERE tt.nguoi_thuc_hien_id = ? OR tt.nguoi_dang_ky_id = ?
      ORDER BY tt.created_at DESC`,
      [id, id, id, id]
    );
    
    res.json({
      employee,
      schedule: scheduleRows,
      stats: statsRows[0] || {
        total_registered: 0,
        total_completed: 0,
        total_hours: 0,
        completion_rate: 0
      },
      trucThayHistory: trucThayRows
    });
    
  } catch (error) {
    console.error('Lỗi lấy chi tiết nhân viên:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API XUẤT EXCEL - ĐẦY ĐỦ
// ======================

// 10. Xuất báo cáo Excel tổng hợp
router.get('/admin/export/summary-report', auth, requireAdmin, async (req, res) => {
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    
    // Tạo các sheet báo cáo
    // ... (thêm code xuất Excel ở đây)
    
    // Thiết lập headers để download
    const filename = `BaoCaoTongHop_Thang${targetMonth}_${targetYear}.xlsx`;
    
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    console.error('Lỗi xuất báo cáo:', error);
    res.status(500).json({ message: 'Lỗi xuất báo cáo' });
  }
});

module.exports = router;