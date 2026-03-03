const express = require('express');
const cors = require('cors');
const app = express();
const router = express.Router();
const db = require('../models/db');
const auth = require('../middleware/auth');
const ExcelJS = require('exceljs');

// Cấu hình CORS
app.use(cors({
  origin: 'http://localhost:3000',         // URL frontend của bạn
  credentials: true,                       // cho phép cookie nếu cần (tùy chọn)
  allowedHeaders: ['Content-Type', 'Authorization'], // cho phép header Authorization
  optionsSuccessStatus: 200                 // một số trình duyệt cũ không hiểu 204
}));

// Helper functions
const pad = (n) => n.toString().padStart(2, '0');
const formatDateLocal = (dateObj) => {
  const d = new Date(dateObj);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// CẬP NHẬT: Status labels
const statusLabel = {
  'registered': 'Đã đăng ký',
  'checked_in': 'Đang làm',
  'checked_out': 'Đã hoàn thành'
};

// Định nghĩa thông tin các ca
const SHIFTS = [
  { key: 'ca1', name: 'Ca 1: 7:00 – 9:30', start: '07:00', end: '09:30' },
  { key: 'ca2', name: 'Ca 2: 9:30 – 12:30', start: '09:30', end: '12:30' },
  { key: 'ca3', name: 'Ca 3: 12:30 – 15:00', start: '12:30', end: '15:00' },
  { key: 'ca4', name: 'Ca 4: 15:00 – 17:30', start: '15:00', end: '17:30' }
];

// Helper: tổng giờ làm trong tháng của 1 nhân viên
const getMonthlyHours = async (ma_nhan_vien, month, year) => {
  const [rows] = await db.query(
    `SELECT COALESCE(SUM(thoi_gian_lam), 0) AS total_hours
     FROM lich_truc
     WHERE ma_nhan_vien = ?
       AND MONTH(ngay) = ?
       AND YEAR(ngay) = ?
       AND thoi_gian_lam IS NOT NULL`,
    [ma_nhan_vien, month, year]
  );
  return Number(rows[0]?.total_hours || 0);
};

// Hàm kiểm tra xem có thể check-out không (LUÔN CHO PHÉP GỬI YÊU CẦU CHO QUÁ KHỨ)
const canCheckOut = (cell) => {
  if (!cell) return { canCheckOut: false, reason: 'Không có thông tin ca' };
  
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const currentDate = now.toISOString().split('T')[0];
  
  const shift = SHIFTS.find(s => s.key === cell.ca);
  if (!shift) return { canCheckOut: false, reason: 'Ca không hợp lệ' };
  
  const shiftStart = shift.start;
  const shiftEnd = shift.end;
  const recordDate = new Date(cell.ngay).toISOString().split('T')[0];
  
  // KIỂM TRA: CHƯA TỚI NGÀY LÀM
  const currentDateObj = new Date(currentDate);
  const recordDateObj = new Date(recordDate);
  
  // Nếu ngày hiện tại nhỏ hơn ngày của ca (ngày trong tương lai)
  if (currentDateObj < recordDateObj) {
    return {
      canCheckOut: false,
      reason: 'Chưa tới ngày làm! Không thể check-out trước ngày làm việc'
    };
  }
  
  // KIỂM TRA: CHƯA TỚI GIỜ LÀM (chỉ áp dụng nếu là cùng ngày)
  if (recordDate === currentDate && currentTime < shiftStart) {
    return {
      canCheckOut: false,
      reason: `Chưa tới giờ làm! Check-out chỉ được thực hiện từ ${shiftStart}`
    };
  }
  
  // === LUÔN CHO PHÉP GỬI YÊU CẦU CHO CA QUÁ HẠN ===
  // Tính số ngày chênh lệch
  const diffTime = Math.abs(now - new Date(cell.ngay));
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  // Nếu là ngày hôm nay nhưng quá giờ
  if (recordDate === currentDate) {
    const [endHours, endMinutes] = shiftEnd.split(':').map(Number);
    const endTimeInMinutes = endHours * 60 + endMinutes;
    
    const [currentHours, currentMinutes] = currentTime.split(':').map(Number);
    const currentTimeInMinutes = currentHours * 60 + currentMinutes;
    
    // Quá 30 phút so với thời gian kết thúc ca
    if (currentTimeInMinutes > (endTimeInMinutes + 30)) {
      return {
        canCheckOut: false,
        canRequestAdjustment: true,
        loai_yeu_cau: 'checkout',
        reason: `Đã quá 30 phút so với thời gian kết thúc ca (${shiftEnd})`,
        message: `Bạn có thể gửi yêu cầu điều chỉnh giờ check-out`
      };
    }
  }
  
  // Nếu là ngày hôm qua, hôm kia hoặc bất kỳ ngày nào trong quá khứ
  if (recordDate < currentDate) {
    return {
      canCheckOut: false,
      canRequestAdjustment: true,
      loai_yeu_cau: 'checkout',
      reason: `Ca này đã qua ${diffDays} ngày`,
      message: `Bạn có thể gửi yêu cầu điều chỉnh giờ check-out cho ca đã qua ${diffDays} ngày`
    };
  }
  
  // Nếu là check-out bình thường (cùng ngày, trong giờ cho phép)
  return {
    canCheckOut: true,
    reason: null
  };
};

// ======================
// MIDDLEWARE: Kiểm tra quyền admin
// ======================
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

// ======================
// ADMIN API: LẤY DANH SÁCH NHÂN VIÊN - ĐẦY ĐỦ
// ======================
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

// ======================
// ADMIN API: TẠO NHÂN VIÊN MỚI
// ======================
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

// ======================
// ADMIN API: CẬP NHẬT NHÂN VIÊN
// ======================
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

// ======================
// ADMIN API: XÓA NHÂN VIÊN
// ======================
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
// ADMIN API: LẤY BÁO CÁO CHẤM CÔNG TỔNG HỢP
// ======================
router.get('/admin/attendance-report', auth, requireAdmin, async (req, res) => {
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    // Lấy chi tiết từng nhân viên
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
        averageCompletionRate: parseFloat(averageCompletionRate.toFixed(2)),
        completionRate: parseFloat(averageCompletionRate.toFixed(2))
      }
    });
  } catch (error) {
    console.error('Lỗi lấy báo cáo chấm công:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: LẤY CHI TIẾT CHẤM CÔNG NHÂN VIÊN
// ======================
router.get('/admin/employee/:id/attendance', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    const [rows] = await db.query(
      `SELECT 
        lt.*,
        DATE(lt.ngay) as ngay_thang
      FROM lich_truc lt
      WHERE lt.nhan_vien_id = ?
        AND MONTH(lt.ngay) = ?
        AND YEAR(lt.ngay) = ?
        AND lt.trang_thai = 'checked_out'
        AND lt.thoi_gian_lam IS NOT NULL
      ORDER BY lt.ngay DESC, 
        CASE lt.ca
          WHEN 'ca1' THEN 1
          WHEN 'ca2' THEN 2
          WHEN 'ca3' THEN 3
          WHEN 'ca4' THEN 4
        END`,
      [id, targetMonth, targetYear]
    );

    // Format dates
    const formattedRows = rows.map(row => ({
      ...row,
      ngay: row.ngay ? formatDateLocal(row.ngay) : null
    }));

    res.json(formattedRows);
  } catch (error) {
    console.error('Lỗi lấy chi tiết chấm công:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: LẤY LỊCH TRỰC NHÂN VIÊN
// ======================
router.get('/admin/employee/:id/schedule', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    const [rows] = await db.query(
      `SELECT 
        lt.*,
        DATE(lt.ngay) as ngay_thang
      FROM lich_truc lt
      WHERE lt.nhan_vien_id = ?
        AND MONTH(lt.ngay) = ?
        AND YEAR(lt.ngay) = ?
      ORDER BY lt.ngay ASC, 
        CASE lt.ca
          WHEN 'ca1' THEN 1
          WHEN 'ca2' THEN 2
          WHEN 'ca3' THEN 3
          WHEN 'ca4' THEN 4
        END`,
      [id, targetMonth, targetYear]
    );

    // Format dates
    const formattedRows = rows.map(row => ({
      ...row,
      ngay: row.ngay ? formatDateLocal(row.ngay) : null
    }));

    res.json(formattedRows);
  } catch (error) {
    console.error('Lỗi lấy lịch trực:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: LẤY THỐNG KÊ THÁNG CỦA NHÂN VIÊN
// ======================
router.get('/admin/employee/:id/monthly-stats', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    const [stats] = await db.query(
      `SELECT 
        (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = ? AND MONTH(ngay) = ? AND YEAR(ngay) = ?) as total_registered,
        (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = ? AND MONTH(ngay) = ? AND YEAR(ngay) = ? AND trang_thai = 'checked_out') as total_completed,
        COALESCE((SELECT SUM(thoi_gian_lam) FROM lich_truc WHERE nhan_vien_id = ? AND MONTH(ngay) = ? AND YEAR(ngay) = ? AND trang_thai = 'checked_out'), 0) as total_hours,
        CASE 
          WHEN (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = ? AND MONTH(ngay) = ? AND YEAR(ngay) = ?) > 0
          THEN ROUND(
            (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = ? AND MONTH(ngay) = ? AND YEAR(ngay) = ? AND trang_thai = 'checked_out') / 
            (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = ? AND MONTH(ngay) = ? AND YEAR(ngay) = ?) * 100, 
            2
          )
          ELSE 0
        END as completion_rate`,
      [
        id, targetMonth, targetYear,
        id, targetMonth, targetYear,
        id, targetMonth, targetYear,
        id, targetMonth, targetYear,
        id, targetMonth, targetYear,
        id, targetMonth, targetYear
      ]
    );

    res.json(stats[0] || {
      total_registered: 0,
      total_completed: 0,
      total_hours: 0,
      completion_rate: 0
    });
  } catch (error) {
    console.error('Lỗi lấy thống kê tháng:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: LẤY CHI TIẾT NHÂN VIÊN (BAO GỒM LỊCH SỬ TRỰC THAY)
// ======================
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
// ADMIN API: LẤY DANH SÁCH USER ĐÃ ĐĂNG KÝ (KHÔNG PHÂN BIỆT QUYỀN)
// ======================
router.get('/admin/registered-users', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        nv.*,
        (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = nv.id) as total_registered_shifts,
        (SELECT COUNT(*) FROM lich_truc WHERE nhan_vien_id = nv.id AND trang_thai = 'checked_out') as total_completed_shifts,
        (SELECT COALESCE(SUM(thoi_gian_lam), 0) FROM lich_truc WHERE nhan_vien_id = nv.id AND trang_thai = 'checked_out') as total_work_hours
      FROM nhanvien nv
      WHERE EXISTS (
        SELECT 1 FROM lich_truc WHERE nhan_vien_id = nv.id
      )
      ORDER BY nv.created_at DESC`
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy danh sách user đã đăng ký:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: LẤY CHI TIẾT USER ĐÃ ĐĂNG KÝ (ĐẦY ĐỦ)
// ======================
router.get('/admin/registered-users/:id/detail', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Thông tin cơ bản
    const [userRows] = await db.query(
      'SELECT * FROM nhanvien WHERE id = ?',
      [id]
    );
    
    if (userRows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }
    
    // Thống kê tổng hợp
    const [stats] = await db.query(
      `SELECT 
        COUNT(*) as total_registered,
        SUM(CASE WHEN trang_thai = 'checked_out' THEN 1 ELSE 0 END) as total_completed,
        COALESCE(SUM(CASE WHEN trang_thai = 'checked_out' THEN thoi_gian_lam ELSE 0 END), 0) as total_hours,
        COUNT(DISTINCT DATE(ngay)) as total_days
      FROM lich_truc
      WHERE nhan_vien_id = ?`,
      [id]
    );
    
    // Lịch sử chi tiết
    const [schedule] = await db.query(
      `SELECT * FROM lich_truc 
       WHERE nhan_vien_id = ?
       ORDER BY ngay DESC, 
         CASE ca
           WHEN 'ca1' THEN 1
           WHEN 'ca2' THEN 2
           WHEN 'ca3' THEN 3
           WHEN 'ca4' THEN 4
         END`,
      [id]
    );
    
    res.json({
      employee: userRows[0],
      stats: stats[0],
      schedule: schedule
    });
    
  } catch (error) {
    console.error('Lỗi lấy chi tiết user:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: XUẤT BÁO CÁO CHẤM CÔNG EXCEL
// ======================
router.get('/admin/export/attendance-report', auth, requireAdmin, async (req, res) => {
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    // Lấy dữ liệu báo cáo
    const [reportRows] = await db.query(
      `SELECT 
        nv.ma_nhan_vien,
        nv.ten_nhan_vien,
        COUNT(DISTINCT DATE(lt.ngay)) as work_days_count,
        GROUP_CONCAT(DISTINCT DATE_FORMAT(lt.ngay, '%d/%m/%Y') ORDER BY lt.ngay SEPARATOR ', ') as work_days,
        COUNT(lt.id) as total_shifts,
        COALESCE(SUM(lt.thoi_gian_lam), 0) as total_hours,
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
      [targetMonth, targetYear, targetMonth, targetYear, targetMonth, targetYear]
    );

    // Lấy chi tiết từng ca làm việc
    const [detailRows] = await db.query(
      `SELECT 
        lt.*,
        nv.ma_nhan_vien,
        nv.ten_nhan_vien,
        DATE(lt.ngay) as ngay_thang
      FROM lich_truc lt
      INNER JOIN nhanvien nv ON lt.nhan_vien_id = nv.id
      WHERE MONTH(lt.ngay) = ?
        AND YEAR(lt.ngay) = ?
        AND lt.trang_thai = 'checked_out'
        AND lt.thoi_gian_lam IS NOT NULL
      ORDER BY nv.ten_nhan_vien, lt.ngay ASC,
        CASE lt.ca
          WHEN 'ca1' THEN 1
          WHEN 'ca2' THEN 2
          WHEN 'ca3' THEN 3
          WHEN 'ca4' THEN 4
        END`,
      [targetMonth, targetYear]
    );

    // Tạo workbook Excel
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hệ thống chấm công';
    workbook.created = new Date();
    
    // ======================
    // SHEET 1: TỔNG HỢP NHÂN VIÊN
    // ======================
    const summarySheet = workbook.addWorksheet('Tổng hợp tháng');
    
    // Tiêu đề
    summarySheet.mergeCells('A1:G1');
    const titleRow = summarySheet.getRow(1);
    titleRow.getCell(1).value = `BÁO CÁO CHẤM CÔNG THÁNG ${targetMonth}/${targetYear}`;
    titleRow.getCell(1).font = { bold: true, size: 16, color: { argb: 'FF1976D2' } };
    titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    titleRow.height = 30;

    summarySheet.mergeCells('A2:G2');
    const dateRow = summarySheet.getRow(2);
    dateRow.getCell(1).value = `Ngày xuất báo cáo: ${new Date().toLocaleDateString('vi-VN')}`;
    dateRow.getCell(1).font = { italic: true };
    dateRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // Header
    const headers = ['STT', 'Mã nhân viên', 'Tên nhân viên', 'Số ngày làm', 'Số ca đã làm', 'Tổng giờ làm', 'Tỷ lệ hoàn thành (%)'];
    const headerRow = summarySheet.getRow(4);
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF2E7D32' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    headerRow.height = 25;

    // Dữ liệu
    reportRows.forEach((row, index) => {
      const dataRow = summarySheet.getRow(index + 5);
      
      dataRow.getCell(1).value = index + 1;
      dataRow.getCell(2).value = row.ma_nhan_vien;
      dataRow.getCell(3).value = row.ten_nhan_vien;
      dataRow.getCell(4).value = row.work_days_count;
      dataRow.getCell(5).value = row.total_shifts;
      dataRow.getCell(6).value = parseFloat(row.total_hours).toFixed(2);
      dataRow.getCell(7).value = parseFloat(row.completion_rate).toFixed(2);
      
      // Căn giữa các cột số
      [1, 4, 5, 6, 7].forEach(col => {
        dataRow.getCell(col).alignment = { vertical: 'middle', horizontal: 'center' };
      });
      
      // Tô màu xen kẽ
      if (index % 2 === 0) {
        for (let i = 1; i <= 7; i++) {
          dataRow.getCell(i).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF5F5F5' }
          };
        }
      }
      
      // Border
      for (let i = 1; i <= 7; i++) {
        dataRow.getCell(i).border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      }
    });

    // Điều chỉnh độ rộng cột
    summarySheet.columns = [
      { width: 6 },   // STT
      { width: 12 },  // Mã NV
      { width: 25 },  // Tên NV
      { width: 12 },  // Số ngày
      { width: 12 },  // Số ca
      { width: 12 },  // Tổng giờ
      { width: 15 }   // Tỷ lệ
    ];

    // ======================
    // SHEET 2: CHI TIẾT TỪNG CA
    // ======================
    const detailSheet = workbook.addWorksheet('Chi tiết ca làm việc');
    
    // Tiêu đề
    detailSheet.mergeCells('A1:J1');
    const detailTitleRow = detailSheet.getRow(1);
    detailTitleRow.getCell(1).value = `CHI TIẾT CA LÀM VIỆC THÁNG ${targetMonth}/${targetYear}`;
    detailTitleRow.getCell(1).font = { bold: true, size: 16, color: { argb: 'FF1976D2' } };
    detailTitleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    detailTitleRow.height = 30;

    // Header chi tiết
    const detailHeaders = [
      'STT', 'Mã NV', 'Tên nhân viên', 'Ngày làm việc', 'Ca làm việc', 
      'Giờ vào', 'Giờ ra', 'Thời gian làm (giờ)', 'Thời gian làm (phút)', 'Trạng thái'
    ];
    
    const detailHeaderRow = detailSheet.getRow(3);
    detailHeaders.forEach((header, index) => {
      const cell = detailHeaderRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1976D2' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    detailHeaderRow.height = 25;

    // Dữ liệu chi tiết
    detailRows.forEach((row, index) => {
      const dataRow = detailSheet.getRow(index + 4);
      
      // Format ca làm việc
      let caLabel = row.ca;
      switch(row.ca) {
        case 'ca1': caLabel = 'Ca 1: 7:00-9:30'; break;
        case 'ca2': caLabel = 'Ca 2: 9:30-12:30'; break;
        case 'ca3': caLabel = 'Ca 3: 12:30-15:00'; break;
        case 'ca4': caLabel = 'Ca 4: 15:00-17:30'; break;
      }
      
      // Format thời gian
      const gioVao = row.gio_vao ? 
        (typeof row.gio_vao === 'string' ? row.gio_vao.substring(0, 5) : row.gio_vao) : '';
      const gioRa = row.gio_ra ? 
        (typeof row.gio_ra === 'string' ? row.gio_ra.substring(0, 5) : row.gio_ra) : '';
      
      // Tính thời gian theo phút
      const thoiGianLamPhut = Math.round((Number(row.thoi_gian_lam) || 0) * 60);
      
      dataRow.getCell(1).value = index + 1;
      dataRow.getCell(2).value = row.ma_nhan_vien;
      dataRow.getCell(3).value = row.ten_nhan_vien;
      dataRow.getCell(4).value = row.ngay ? formatDateLocal(row.ngay) : '';
      dataRow.getCell(5).value = caLabel;
      dataRow.getCell(6).value = gioVao;
      dataRow.getCell(7).value = gioRa;
      dataRow.getCell(8).value = Number(row.thoi_gian_lam).toFixed(2);
      dataRow.getCell(9).value = thoiGianLamPhut;
      dataRow.getCell(10).value = 'Hoàn thành';
      
      // Căn giữa các cột
      [1, 2, 4, 5, 6, 7, 8, 9, 10].forEach(col => {
        dataRow.getCell(col).alignment = { vertical: 'middle', horizontal: 'center' };
      });
      
      // Tô màu xen kẽ
      if (index % 2 === 0) {
        for (let i = 1; i <= 10; i++) {
          dataRow.getCell(i).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF5F5F5' }
          };
        }
      }
      
      // Border
      for (let i = 1; i <= 10; i++) {
        dataRow.getCell(i).border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      }
    });

    // Điều chỉnh độ rộng cột
    detailSheet.columns = [
      { width: 6 },   // STT
      { width: 10 },  // Mã NV
      { width: 25 },  // Tên NV
      { width: 15 },  // Ngày
      { width: 20 },  // Ca
      { width: 10 },  // Giờ vào
      { width: 10 },  // Giờ ra
      { width: 15 },  // Giờ làm
      { width: 15 },  // Phút làm
      { width: 12 }   // Trạng thái
    ];

    // ======================
    // SHEET 3: TỔNG KẾT
    // ======================
    const totalSheet = workbook.addWorksheet('Tổng kết tháng');
    
    // Tính tổng thống kê
    let totalEmployees = reportRows.length;
    let totalShifts = 0;
    let totalHours = 0;
    let employeesWithShifts = 0;

    reportRows.forEach(emp => {
      totalShifts += emp.total_shifts || 0;
      totalHours += parseFloat(emp.total_hours || 0);
      if (emp.total_shifts > 0) employeesWithShifts++;
    });

    const averageHours = employeesWithShifts > 0 ? totalHours / employeesWithShifts : 0;

    // Tiêu đề
    totalSheet.mergeCells('A1:B1');
    totalSheet.getRow(1).getCell(1).value = 'TỔNG KẾT THÁNG';
    totalSheet.getRow(1).getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1976D2' } };
    totalSheet.getRow(1).getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // Dữ liệu tổng kết
    const summaryData = [
      ['Tháng báo cáo', `${targetMonth}/${targetYear}`],
      ['Ngày xuất báo cáo', new Date().toLocaleDateString('vi-VN')],
      ['Tổng số nhân viên', totalEmployees],
      ['Số nhân viên có chấm công', employeesWithShifts],
      ['Tổng số ca đã làm', totalShifts],
      ['Tổng số giờ làm', totalHours.toFixed(2)],
      ['Số giờ trung bình/người', averageHours.toFixed(2)],
      ['Số ca trung bình/người', (totalShifts / (employeesWithShifts || 1)).toFixed(1)]
    ];

    summaryData.forEach((row, index) => {
      const dataRow = totalSheet.getRow(index + 3);
      dataRow.getCell(1).value = row[0];
      dataRow.getCell(2).value = row[1];
      
      dataRow.getCell(1).font = { bold: true };
      dataRow.getCell(2).alignment = { horizontal: 'center' };
      
      // Tô màu cho hàng tổng kết
      if (index >= 2) {
        dataRow.getCell(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF0F7FF' }
        };
        dataRow.getCell(2).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF0F7FF' }
        };
      }
      
      // Border
      [1, 2].forEach(col => {
        dataRow.getCell(col).border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
    });

    // Điều chỉnh độ rộng
    totalSheet.columns = [
      { width: 25 },
      { width: 20 }
    ];

    // Thiết lập headers để download file
    const filename = `BaoCaoChamCong_Thang${targetMonth}_${targetYear}.xlsx`;
    
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    // Ghi workbook vào response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Lỗi xuất Excel:', error);
    res.status(500).json({ message: 'Lỗi xuất báo cáo Excel: ' + error.message });
  }
});

// ======================
// ADMIN API: XUẤT BÁO CÁO TỔNG HỢP
// ======================
router.get('/admin/export/summary-report', auth, requireAdmin, async (req, res) => {
  const { month, year } = req.query;
  
  const targetMonth = month || new Date().getMonth() + 1;
  const targetYear = year || new Date().getFullYear();

  try {
    // Lấy dữ liệu tổng hợp
    const [summaryRows] = await db.query(
      `SELECT 
        nv.ma_nhan_vien,
        nv.ten_nhan_vien,
        COUNT(lt.id) as total_shifts,
        COALESCE(SUM(lt.thoi_gian_lam), 0) as total_hours,
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
      ORDER BY total_hours DESC, total_shifts DESC
      LIMIT 10`,
      [targetMonth, targetYear, targetMonth, targetYear, targetMonth, targetYear]
    );

    // Lấy dữ liệu theo tuần
    const [weeklyData] = await db.query(
      `SELECT 
        WEEK(lt.ngay, 1) as week_number,
        COUNT(lt.id) as total_shifts,
        COALESCE(SUM(lt.thoi_gian_lam), 0) as total_hours,
        COUNT(DISTINCT lt.nhan_vien_id) as employees_count
      FROM lich_truc lt
      WHERE MONTH(lt.ngay) = ?
        AND YEAR(lt.ngay) = ?
        AND lt.trang_thai = 'checked_out'
        AND lt.thoi_gian_lam IS NOT NULL
      GROUP BY WEEK(lt.ngay, 1)
      ORDER BY week_number`,
      [targetMonth, targetYear]
    );

    // Tạo workbook Excel
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hệ thống chấm công';
    workbook.created = new Date();
    
    // SHEET 1: TOP NHÂN VIÊN
    const topSheet = workbook.addWorksheet('Top nhân viên');
    
    // Tiêu đề
    topSheet.mergeCells('A1:E1');
    topSheet.getRow(1).getCell(1).value = `TOP 10 NHÂN VIÊN TÍCH CỰC THÁNG ${targetMonth}/${targetYear}`;
    topSheet.getRow(1).getCell(1).font = { bold: true, size: 16, color: { argb: 'FF1976D2' } };
    topSheet.getRow(1).getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    topSheet.getRow(1).height = 30;

    // Header
    const headers = ['STT', 'Mã nhân viên', 'Tên nhân viên', 'Số ca đã làm', 'Tổng giờ làm', 'Tỷ lệ hoàn thành (%)'];
    const headerRow = topSheet.getRow(3);
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF2E7D32' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    headerRow.height = 25;

    // Dữ liệu
    summaryRows.forEach((row, index) => {
      const dataRow = topSheet.getRow(index + 4);
      
      dataRow.getCell(1).value = index + 1;
      dataRow.getCell(2).value = row.ma_nhan_vien;
      dataRow.getCell(3).value = row.ten_nhan_vien;
      dataRow.getCell(4).value = row.total_shifts;
      dataRow.getCell(5).value = parseFloat(row.total_hours).toFixed(2);
      dataRow.getCell(6).value = parseFloat(row.completion_rate).toFixed(2);
      
      // Căn giữa
      [1, 4, 5, 6].forEach(col => {
        dataRow.getCell(col).alignment = { vertical: 'middle', horizontal: 'center' };
      });
      
      // Tô màu cho top 3
      if (index < 3) {
        for (let i = 1; i <= 6; i++) {
          dataRow.getCell(i).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: index === 0 ? 'FFFFFFE0' : index === 1 ? 'FFE8F5E8' : 'FFE3F2FD' }
          };
        }
      }
      
      // Border
      for (let i = 1; i <= 6; i++) {
        dataRow.getCell(i).border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      }
    });

    // Điều chỉnh độ rộng
    topSheet.columns = [
      { width: 6 },
      { width: 12 },
      { width: 25 },
      { width: 12 },
      { width: 12 },
      { width: 15 }
    ];

    // SHEET 2: PHÂN BỐ THEO TUẦN
    const weeklySheet = workbook.addWorksheet('Phân bố theo tuần');
    
    // Tiêu đề
    weeklySheet.mergeCells('A1:D1');
    weeklySheet.getRow(1).getCell(1).value = `PHÂN BỐ GIỜ LÀM THEO TUẦN THÁNG ${targetMonth}/${targetYear}`;
    weeklySheet.getRow(1).getCell(1).font = { bold: true, size: 16, color: { argb: 'FF1976D2' } };
    weeklySheet.getRow(1).getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    weeklySheet.getRow(1).height = 30;

    // Header
    const weeklyHeaders = ['Tuần', 'Số nhân viên', 'Số ca đã làm', 'Tổng giờ làm'];
    const weeklyHeaderRow = weeklySheet.getRow(3);
    weeklyHeaders.forEach((header, index) => {
      const cell = weeklyHeaderRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1976D2' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    weeklyHeaderRow.height = 25;

    // Dữ liệu
    weeklyData.forEach((row, index) => {
      const dataRow = weeklySheet.getRow(index + 4);
      
      dataRow.getCell(1).value = `Tuần ${row.week_number}`;
      dataRow.getCell(2).value = row.employees_count;
      dataRow.getCell(3).value = row.total_shifts;
      dataRow.getCell(4).value = parseFloat(row.total_hours).toFixed(2);
      
      // Căn giữa
      [1, 2, 3, 4].forEach(col => {
        dataRow.getCell(col).alignment = { vertical: 'middle', horizontal: 'center' };
      });
      
      // Tô màu xen kẽ
      if (index % 2 === 0) {
        for (let i = 1; i <= 4; i++) {
          dataRow.getCell(i).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF5F5F5' }
          };
        }
      }
      
      // Border
      for (let i = 1; i <= 4; i++) {
        dataRow.getCell(i).border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      }
    });

    // Điều chỉnh độ rộng
    weeklySheet.columns = [
      { width: 15 },
      { width: 15 },
      { width: 15 },
      { width: 15 }
    ];

    // Thiết lập headers để download file
    const filename = `BaoCaoTongHop_Thang${targetMonth}_${targetYear}.xlsx`;
    
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    // Ghi workbook vào response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Lỗi xuất báo cáo tổng hợp:', error);
    res.status(500).json({ message: 'Lỗi xuất báo cáo: ' + error.message });
  }
});

// ======================
// ADMIN API: LẤY DANH SÁCH TRỰC THAY CHỜ DUYỆT
// ======================
router.get('/admin/pending-tructhay', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        tt.*,
        -- Thông tin người trực thay (B)
        nv_thuc_hien.ten_nhan_vien as ten_nguoi_truc_thay,
        nv_thuc_hien.ma_nhan_vien as ma_nguoi_truc_thay,
        
        -- Thông tin người được trực thay (A)
        nv_dang_ky.ten_nhan_vien as ten_nguoi_duoc_truc_thay,
        nv_dang_ky.ma_nhan_vien as ma_nguoi_duoc_truc_thay,
        
        -- Thông tin lịch trực
        lt.ngay,
        lt.ca
        
      FROM truc_thay tt
      INNER JOIN nhanvien nv_thuc_hien ON tt.nguoi_thuc_hien_id = nv_thuc_hien.id
      INNER JOIN nhanvien nv_dang_ky ON tt.nguoi_dang_ky_id = nv_dang_ky.id
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

// ======================
// ADMIN API: DUYỆT/TỪ CHỐI TRỰC THAY
// ======================
router.post('/admin/tructhay/:id/approve', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { approve } = req.body; // true: duyệt, false: từ chối

  try {
    const [trucThayRows] = await db.query(
      'SELECT * FROM truc_thay WHERE id = ?',
      [id]
    );

    if (trucThayRows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy yêu cầu trực thay' });
    }

    const trucThay = trucThayRows[0];

    if (approve) {
      // Duyệt: cập nhật trạng thái thành active
      await db.query(
        'UPDATE truc_thay SET trang_thai = "active", admin_duyet = 1, updated_at = NOW() WHERE id = ?',
        [id]
      );

      // Cập nhật ghi chú lịch gốc
      await db.query(
        `UPDATE lich_truc 
         SET ghi_chu = CONCAT(
           COALESCE(ghi_chu, ''), 
           ' | Được trực thay bởi: ', 
           (SELECT ten_nhan_vien FROM nhanvien WHERE id = ?), 
           ' (', 
           (SELECT ma_nhan_vien FROM nhanvien WHERE id = ?), 
           ')'
         ),
         updated_at = NOW()
         WHERE id = ?`,
        [trucThay.nguoi_thuc_hien_id, trucThay.nguoi_thuc_hien_id, trucThay.lich_truc_goc_id]
      );

      res.json({ 
        message: 'Đã duyệt yêu cầu trực thay',
        data: { id, status: 'active' }
      });
    } else {
      // Từ chối: xóa bản ghi trực thay và lịch ảo
      await db.query('START TRANSACTION');
      
      try {
        // Xóa lịch trực ảo
        await db.query('DELETE FROM lich_truc WHERE id = ?', [trucThay.lich_truc_ao_id]);
        
        // Xóa bản ghi trực thay
        await db.query('DELETE FROM truc_thay WHERE id = ?', [id]);
        
        // Khôi phục lịch gốc (xóa ghi chú chờ duyệt)
        await db.query(
          `UPDATE lich_truc 
           SET ghi_chu = REPLACE(ghi_chu, 
             CONCAT(' | Đang chờ trực thay bởi: ', 
               (SELECT ten_nhan_vien FROM nhanvien WHERE id = ?), 
               ' (', 
               (SELECT ma_nhan_vien FROM nhanvien WHERE id = ?), 
               ') - Lý do: ', ?, ' (Chờ duyệt)'
             ), ''
           ),
           updated_at = NOW()
           WHERE id = ?`,
          [trucThay.nguoi_thuc_hien_id, trucThay.nguoi_thuc_hien_id, trucThay.ly_do, trucThay.lich_truc_goc_id]
        );

        await db.query('COMMIT');
        
        res.json({ 
          message: 'Đã từ chối yêu cầu trực thay',
          data: { id, status: 'rejected' }
        });
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
  } catch (error) {
    console.error('Lỗi xử lý trực thay:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: LẤY THÔNG TIN TRỰC THAY CỦA NHÂN VIÊN
// ======================
router.get('/admin/employee/:id/tructhay', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT 
        tt.*,
        CASE 
          WHEN tt.nguoi_thuc_hien_id = ? THEN 'thuc_hien'
          WHEN tt.nguoi_dang_ky_id = ? THEN 'duoc_truc_thay'
        END as loai,
        
        -- Thông tin người trực thay
        nv_thuc_hien.ten_nhan_vien as ten_nguoi_truc_thay,
        nv_thuc_hien.ma_nhan_vien as ma_nguoi_truc_thay,
        
        -- Thông tin người được trực thay
        nv_dang_ky.ten_nhan_vien as ten_nguoi_duoc_truc_thay,
        nv_dang_ky.ma_nhan_vien as ma_nguoi_duoc_truc_thay,
        
        -- Thông tin lịch trực
        lt.ngay,
        lt.ca
        
      FROM truc_thay tt
      INNER JOIN nhanvien nv_thuc_hien ON tt.nguoi_thuc_hien_id = nv_thuc_hien.id
      INNER JOIN nhanvien nv_dang_ky ON tt.nguoi_dang_ky_id = nv_dang_ky.id
      INNER JOIN lich_truc lt ON tt.lich_truc_goc_id = lt.id
      
      WHERE tt.nguoi_thuc_hien_id = ? OR tt.nguoi_dang_ky_id = ?
      ORDER BY tt.created_at DESC`,
      [id, id, id, id]
    );

    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy thông tin trực thay:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: TỔNG QUAN THỐNG KÊ
// ======================
router.get('/admin/overview-stats', auth, requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const [stats] = await db.query(
      `SELECT 
        -- Tổng nhân viên
        (SELECT COUNT(*) FROM nhanvien) as total_employees,
        
        -- Nhân viên đang làm hôm nay
        (SELECT COUNT(DISTINCT nhan_vien_id) 
         FROM lich_truc 
         WHERE DATE(ngay) = ? 
           AND trang_thai IN ('checked_in', 'checked_out')) as active_today,
        
        -- Tổng số ca trong tháng
        (SELECT COUNT(*) 
         FROM lich_truc 
         WHERE MONTH(ngay) = ? 
           AND YEAR(ngay) = ?) as total_shifts_this_month,
        
        -- Tổng giờ làm trong tháng
        (SELECT COALESCE(SUM(thoi_gian_lam), 0) 
         FROM lich_truc 
         WHERE MONTH(ngay) = ? 
           AND YEAR(ngay) = ? 
           AND trang_thai = 'checked_out') as total_hours_this_month,
        
        -- Trực thay chờ duyệt
        (SELECT COUNT(*) 
         FROM truc_thay 
         WHERE trang_thai = 'pending') as pending_truc_thay,
         
        -- Yêu cầu điều chỉnh giờ chờ duyệt
        (SELECT COUNT(*) 
         FROM yeu_cau_dieu_chinh_gio 
         WHERE trang_thai = 'pending') as pending_time_adjustments`,
      [today, currentMonth, currentYear, currentMonth, currentYear]
    );

    res.json({
      totalEmployees: stats[0].total_employees,
      activeToday: stats[0].active_today,
      totalShiftsThisMonth: stats[0].total_shifts_this_month,
      totalHoursThisMonth: parseFloat(stats[0].total_hours_this_month) || 0,
      pendingTrucThay: stats[0].pending_truc_thay || 0,
      pendingTimeAdjustments: stats[0].pending_time_adjustments || 0
    });
  } catch (error) {
    console.error('Lỗi lấy thống kê:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API: LẤY LỊCH TRỰC THEO THÁNG (ĐÃ CẬP NHẬT HIỂN THỊ TRỰC THAY - PHIÊN BẢN MỚI)
// ======================
router.get('/schedule', auth, async (req, res) => {
  const month = Number(req.query.month) || new Date().getMonth() + 1;
  const year = Number(req.query.year) || new Date().getFullYear();
  const { ma_nhan_vien } = req.employee;
  
  try {
    // QUERY MỚI - LẤY ĐÚNG THÔNG TIN PHÂN BIỆT
    const [rows] = await db.query(
      `SELECT 
        lt.*,
        nv.ten_nhan_vien,
        nv.ma_nhan_vien,
        nv.id as nhan_vien_id,
        
        -- Thông tin trực thay (nếu có)
        tt.id as truc_thay_id,
        tt.nguoi_dang_ky_id,
        tt.nguoi_thuc_hien_id,
        tt.lich_truc_ao_id,
        tt.ly_do,
        tt.trang_thai as trang_thai_truc_thay,
        
        -- Thông tin người thực hiện trực thay (B)
        nv_thuc_hien.ten_nhan_vien as ten_nguoi_truc_thay,
        nv_thuc_hien.ma_nhan_vien as ma_nguoi_truc_thay,
        
        -- Thông tin người đăng ký gốc (A) - chỉ có khi đây là lịch ảo
        nv_dang_ky.ten_nhan_vien as ten_nguoi_duoc_truc_thay,
        nv_dang_ky.ma_nhan_vien as ma_nguoi_duoc_truc_thay,
        
        -- Xác định loại lịch
        CASE 
          WHEN tt.id IS NOT NULL AND tt.lich_truc_ao_id = lt.id THEN 'virtual' -- Lịch ảo của người trực thay (B)
          WHEN tt.id IS NOT NULL AND tt.lich_truc_goc_id = lt.id THEN 'original' -- Lịch gốc của người đăng ký (A)
          ELSE 'normal' -- Lịch bình thường
        END as loai_lich
        
      FROM lich_truc lt
      INNER JOIN nhanvien nv ON lt.nhan_vien_id = nv.id
      
      -- LEFT JOIN với truc_thay để lấy thông tin trực thay
      LEFT JOIN truc_thay tt ON 
        (lt.id = tt.lich_truc_goc_id OR lt.id = tt.lich_truc_ao_id)
        AND tt.trang_thai IN ('active', 'completed')
      
      -- LEFT JOIN để lấy thông tin người trực thay (B)
      LEFT JOIN nhanvien nv_thuc_hien ON tt.nguoi_thuc_hien_id = nv_thuc_hien.id
      
      -- LEFT JOIN để lấy thông tin người đăng ký gốc (A) - cho lịch ảo
      LEFT JOIN nhanvien nv_dang_ky ON tt.nguoi_dang_ky_id = nv_dang_ky.id
      
      WHERE MONTH(lt.ngay) = ? AND YEAR(lt.ngay) = ? 
      ORDER BY lt.ngay ASC, lt.ca ASC, lt.ten_nhan_vien ASC`,
      [month, year]
    );
    
    // XỬ LÝ DỮ LIỆU ĐỂ PHÂN BIỆT RÕ
    const formattedRows = rows.map(row => {
      const isVirtual = row.loai_lich === 'virtual'; // Lịch ảo của người trực thay (B)
      const isOriginal = row.loai_lich === 'original'; // Lịch gốc của người đăng ký (A)
      
      let display_info = {
        display_status: statusLabel[row.trang_thai] || row.trang_thai,
        is_truc_thay_related: false,
        truc_thay_type: null
      };
      
      // TRƯỜNG HỢP 1: Đây là lịch ảo của người trực thay (B)
      if (isVirtual && row.truc_thay_id) {
        display_info = {
          display_status: `Trực thay cho ${row.ten_nguoi_duoc_truc_thay || row.ten_nhan_vien}`,
          is_truc_thay_related: true,
          truc_thay_type: 'performer', // Người thực hiện trực thay
          nguoi_duoc_truc_thay: row.ten_nguoi_duoc_truc_thay,
          ma_nguoi_duoc_truc_thay: row.ma_nguoi_duoc_truc_thay,
          can_cancel_truc_thay: row.trang_thai === 'registered'
        };
      }
      // TRƯỜNG HỢP 2: Đây là lịch gốc của người đăng ký (A) được trực thay
      else if (isOriginal && row.truc_thay_id) {
        display_info = {
          display_status: `Được trực thay bởi ${row.ten_nguoi_truc_thay || 'Ai đó'}`,
          is_truc_thay_related: true,
          truc_thay_type: 'receiver', // Người được trực thay
          nguoi_truc_thay: row.ten_nguoi_truc_thay,
          ma_nguoi_truc_thay: row.ma_nguoi_truc_thay,
          is_original_registrant: true
        };
      }
      
      return {
        ...row,
        ngay: row.ngay ? formatDateLocal(row.ngay) : null,
        // Thông tin hiển thị
        ...display_info,
        // Giữ nguyên các trường khác
        loai_lich: row.loai_lich,
        truc_thay_id: row.truc_thay_id
      };
    });
    
    res.json(formattedRows);
  } catch (error) {
    console.error('Lỗi lấy lịch trực:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API: Lấy chi tiết trực thay theo lịch trực
// ======================
router.get('/truc-thay/detail/:lich_truc_id', auth, async (req, res) => {
  const { lich_truc_id } = req.params;
  
  try {
    const [rows] = await db.query(
      `SELECT 
        tt.*,
        -- Thông tin lịch gốc (A)
        lt_goc.ngay as ngay_goc,
        lt_goc.ca as ca_goc,
        nv_goc.ten_nhan_vien as ten_nguoi_dang_ky,
        nv_goc.ma_nhan_vien as ma_nguoi_dang_ky,
        
        -- Thông tin lịch ảo (B)
        lt_ao.ngay as ngay_ao,
        lt_ao.ca as ca_ao,
        nv_ao.ten_nhan_vien as ten_nguoi_truc_thay,
        nv_ao.ma_nhan_vien as ma_nguoi_truc_thay
        
      FROM truc_thay tt
      INNER JOIN lich_truc lt_goc ON tt.lich_truc_goc_id = lt_goc.id
      INNER JOIN nhanvien nv_goc ON tt.nguoi_dang_ky_id = nv_goc.id
      INNER JOIN lich_truc lt_ao ON tt.lich_truc_ao_id = lt_ao.id
      INNER JOIN nhanvien nv_ao ON tt.nguoi_thuc_hien_id = nv_ao.id
      
      WHERE tt.lich_truc_goc_id = ? OR tt.lich_truc_ao_id = ?`,
      [lich_truc_id, lich_truc_id]
    );
    
    if (rows.length === 0) {
      return res.json({ 
        success: false, 
        message: 'Không có thông tin trực thay' 
      });
    }
    
    const detail = rows[0];
    const result = {
      success: true,
      data: {
        // Thông tin người đăng ký gốc (A)
        nguoi_dang_ky: {
          ten: detail.ten_nguoi_dang_ky,
          ma: detail.ma_nguoi_dang_ky,
          lich_truc_id: detail.lich_truc_goc_id,
          ngay: detail.ngay_goc,
          ca: detail.ca_goc
        },
        // Thông tin người trực thay (B)
        nguoi_truc_thay: {
          ten: detail.ten_nguoi_truc_thay,
          ma: detail.ma_nguoi_truc_thay,
          lich_truc_id: detail.lich_truc_ao_id,
          ngay: detail.ngay_ao,
          ca: detail.ca_ao
        },
        // Thông tin trực thay
        ly_do: detail.ly_do,
        trang_thai: detail.trang_thai,
        created_at: detail.created_at
      }
    };
    
    res.json(result);
  } catch (error) {
    console.error('Lỗi lấy chi tiết trực thay:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Lỗi server' 
    });
  }
});

// ======================
// API: Trực thay (FIXED VERSION)
// ======================
router.post('/truc-thay/request', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const { lich_truc_id, ly_do } = req.body;

  console.log('=== TRỰC THAY REQUEST ===');
  console.log('Người yêu cầu:', { ma_nhan_vien, ten_nhan_vien });
  console.log('Lịch trực ID:', lich_truc_id);
  console.log('Lý do:', ly_do);

  try {
    // 1. Lấy thông tin người yêu cầu trực thay
    const [requesterRows] = await db.query(
      'SELECT id FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );
    
    if (requesterRows.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Người yêu cầu không tồn tại' 
      });
    }
    
    const requester_id = requesterRows[0].id;

    // 2. Lấy thông tin lịch trực gốc
    const [originalScheduleRows] = await db.query(
      `SELECT lt.*, nv.ten_nhan_vien, nv.ma_nhan_vien, nv.id as nhan_vien_id 
       FROM lich_truc lt 
       JOIN nhanvien nv ON lt.nhan_vien_id = nv.id 
       WHERE lt.id = ?`,
      [lich_truc_id]
    );
    
    if (originalScheduleRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Không tìm thấy lịch trực' 
      });
    }

    const originalSchedule = originalScheduleRows[0];
    const original_owner_id = originalSchedule.nhan_vien_id;
    const original_owner_name = originalSchedule.ten_nhan_vien;
    const original_owner_code = originalSchedule.ma_nhan_vien;

    console.log('Thông tin lịch gốc:', {
      id: originalSchedule.id,
      ngay: originalSchedule.ngay,
      ca: originalSchedule.ca,
      chủ_sở_hữu: original_owner_name,
      trạng_thái: originalSchedule.trang_thai
    });

    // 3. Kiểm tra điều kiện
    const errors = [];

    // Không thể trực thay cho chính mình
    if (requester_id === original_owner_id) {
      errors.push('Không thể trực thay cho chính mình');
    }

    // Chỉ được trực thay khi ca chưa bắt đầu
    if (originalSchedule.trang_thai !== 'registered') {
      errors.push('Chỉ có thể trực thay khi ca chưa bắt đầu');
    }

    // Kiểm tra người trực thay có trùng lịch không
    const [conflictSchedule] = await db.query(
      `SELECT id FROM lich_truc 
       WHERE ngay = ? 
         AND ca = ? 
         AND nhan_vien_id = ? 
         AND trang_thai != 'checked_out'`,
      [originalSchedule.ngay, originalSchedule.ca, requester_id]
    );
    
    if (conflictSchedule.length > 0) {
      errors.push('Bạn đã có lịch vào thời gian này');
    }

    // Kiểm tra xem ca này đã được trực thay chưa
    const [existingTrucThay] = await db.query(
      'SELECT id FROM truc_thay WHERE lich_truc_goc_id = ? AND trang_thai != "completed"',
      [lich_truc_id]
    );
    
    if (existingTrucThay.length > 0) {
      errors.push('Ca này đã được trực thay');
    }

    if (errors.length > 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Không thể trực thay',
        errors: errors 
      });
    }

    // 4. BẮT ĐẦU TRANSACTION
    await db.query('START TRANSACTION');

    try {
      // 5. Tạo lịch trực ảo cho người trực thay
      const [virtualScheduleResult] = await db.query(
        `INSERT INTO lich_truc 
         (ngay, ca, nhan_vien_id, ma_nhan_vien, ten_nhan_vien, trang_thai, ghi_chu) 
         VALUES (?, ?, ?, ?, ?, 'registered', ?)`,
        [
          originalSchedule.ngay,
          originalSchedule.ca,
          requester_id,
          ma_nhan_vien,
          ten_nhan_vien,
          `TRỰC THAY - Lịch gốc ID: ${lich_truc_id} - Trực thay cho: ${original_owner_name} (${original_owner_code}) - Lý do: ${ly_do || 'Không có lý do'}`
        ]
      );

      const virtual_schedule_id = virtualScheduleResult.insertId;
      console.log('✅ Đã tạo lịch ảo ID:', virtual_schedule_id);

      // 6. Tạo bản ghi trực thay
      const [trucThayResult] = await db.query(
        `INSERT INTO truc_thay 
         (lich_truc_goc_id, nguoi_dang_ky_id, nguoi_thuc_hien_id, lich_truc_ao_id, ly_do, trang_thai) 
         VALUES (?, ?, ?, ?, ?, 'pending')`, // Thay đổi: trạng thái pending thay vì active
        [
          lich_truc_id,
          original_owner_id,
          requester_id,
          virtual_schedule_id,
          ly_do || 'Không có lý do'
        ]
      );

      const truc_thay_id = trucThayResult.insertId;
      console.log('✅ Đã tạo bản ghi trực thay ID:', truc_thay_id);

      // 7. Cập nhật lịch gốc - thêm ghi chú đang chờ duyệt
      await db.query(
        `UPDATE lich_truc 
         SET ghi_chu = CONCAT(
           COALESCE(ghi_chu, ''), 
           ' | Đang chờ trực thay bởi: ', ?, ' (', ?, ') - Lý do: ', ?, ' (Chờ duyệt)'
         ),
         updated_at = NOW()
         WHERE id = ?`,
        [
          ten_nhan_vien,
          ma_nhan_vien,
          ly_do || 'Không có lý do',
          lich_truc_id
        ]
      );

      console.log('✅ Đã cập nhật lịch gốc');

      // 8. Tạo thông báo cho người đăng ký gốc
      await db.query(
        `INSERT INTO thong_bao_truc_thay 
         (nguoi_nhan_id, nguoi_gui_id, lich_truc_id, noi_dung) 
         VALUES (?, ?, ?, ?)`,
        [
          original_owner_id,
          requester_id,
          lich_truc_id,
          `${ten_nhan_vien} (${ma_nhan_vien}) đã yêu cầu trực thay ca ${originalSchedule.ca} ngày ${new Date(originalSchedule.ngay).toLocaleDateString('vi-VN')} cho bạn. Đang chờ admin duyệt. Lý do: ${ly_do || 'Không có lý do'}`
        ]
      );

      console.log('✅ Đã gửi thông báo');

      await db.query('COMMIT');
      console.log('✅ TRANSACTION thành công');

      res.json({
        success: true,
        message: `Đã gửi yêu cầu trực thay thành công cho ${original_owner_name}. Đang chờ admin duyệt.`,
        important_note: `⚠️ Yêu cầu của bạn đang chờ admin duyệt. Bạn sẽ được thông báo khi được duyệt.`,
        data: {
          truc_thay_id: truc_thay_id,
          lich_truc_goc_id: lich_truc_id,
          lich_truc_ao_id: virtual_schedule_id,
          nguoi_dang_ky: {
            ten: original_owner_name,
            ma: original_owner_code
          },
          status: 'pending'
        }
      });

    } catch (error) {
      await db.query('ROLLBACK');
      console.error('❌ Transaction lỗi:', error);
      throw error;
    }

  } catch (error) {
    console.error('❌ Lỗi trực thay:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi xử lý trực thay',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================
// API: HỦY TRỰC THAY (BACKEND) - PHIÊN BẢN MỚI
// ======================
router.delete('/truc-thay/cancel/:lich_truc_goc_id', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const { lich_truc_goc_id } = req.params;

  console.log('=== HỦY TRỰC THAY BACKEND ===');
  console.log('Người yêu cầu:', { ma_nhan_vien, ten_nhan_vien });
  console.log('Lịch trực gốc ID:', lich_truc_goc_id);

  try {
    // 1. Lấy thông tin người yêu cầu hủy
    const [requesterRows] = await db.query(
      'SELECT id, ten_nhan_vien FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );
    
    if (requesterRows.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Người yêu cầu không tồn tại' 
      });
    }
    
    const requester = requesterRows[0];

    // 2. Lấy thông tin đầy đủ về trực thay
    const [trucThayRows] = await db.query(
      `SELECT 
        tt.*,
        -- Thông tin lịch trực gốc (A)
        lt_goc.id as lich_truc_goc_id,
        lt_goc.ngay as ngay_goc,
        lt_goc.ca as ca_goc,
        lt_goc.trang_thai as trang_thai_goc,
        lt_goc.gio_vao as gio_vao_goc,
        lt_goc.gio_ra as gio_ra_goc,
        lt_goc.thoi_gian_lam as thoi_gian_lam_goc,
        lt_goc.ghi_chu as ghi_chu_goc,
        nv_goc.id as nguoi_dang_ky_id,
        nv_goc.ten_nhan_vien as ten_nguoi_dang_ky,
        nv_goc.ma_nhan_vien as ma_nguoi_dang_ky,
        
        -- Thông tin lịch trực ảo (B)
        lt_ao.id as lich_truc_ao_id,
        lt_ao.ngay as ngay_ao,
        lt_ao.ca as ca_ao,
        lt_ao.trang_thai as trang_thai_ao,
        lt_ao.gio_vao as gio_vao_ao,
        lt_ao.gio_ra as gio_ra_ao,
        lt_ao.thoi_gian_lam as thoi_gian_lam_ao,
        lt_ao.ghi_chu as ghi_chu_ao,
        nv_ao.id as nguoi_thuc_hien_id,
        nv_ao.ten_nhan_vien as ten_nguoi_thuc_hien,
        nv_ao.ma_nhan_vien as ma_nguoi_thuc_hien
        
      FROM truc_thay tt
      INNER JOIN lich_truc lt_goc ON tt.lich_truc_goc_id = lt_goc.id
      INNER JOIN nhanvien nv_goc ON tt.nguoi_dang_ky_id = nv_goc.id
      INNER JOIN lich_truc lt_ao ON tt.lich_truc_ao_id = lt_ao.id
      INNER JOIN nhanvien nv_ao ON tt.nguoi_thuc_hien_id = nv_ao.id
      
      WHERE tt.lich_truc_goc_id = ? 
        AND tt.nguoi_thuc_hien_id = ?
        AND tt.trang_thai IN ('active', 'pending')`, // Cho phép hủy cả pending và active
      [lich_truc_goc_id, requester.id]
    );
    
    if (trucThayRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Không tìm thấy bản ghi trực thay hoặc bạn không có quyền hủy' 
      });
    }

    const trucThay = trucThayRows[0];

    console.log('Thông tin trực thay:', {
      id: trucThay.id,
      trạng_thái: trucThay.trang_thai,
      người_đăng_ký: trucThay.ten_nguoi_dang_ky,
      người_trực_thay: trucThay.ten_nguoi_thuc_hien,
      lịch_gốc_trạng_thái: trucThay.trang_thai_goc,
      lịch_ảo_trạng_thái: trucThay.trang_thai_ao
    });

    // 3. KIỂM TRA ĐIỀU KIỆN HỦY (BACKEND VALIDATION)
    const errors = [];

    // Không được hủy nếu ca đã được check-in (chỉ áp dụng cho trạng thái active)
    if (trucThay.trang_thai === 'active') {
      if (trucThay.trang_thai_goc !== 'registered' || trucThay.trang_thai_ao !== 'registered') {
        errors.push('Không thể hủy trực thay khi ca đã được check-in');
      }
    }

    // Người hủy phải là người trực thay
    if (trucThay.nguoi_thuc_hien_id !== requester.id) {
      errors.push('Chỉ người trực thay mới được hủy');
    }

    if (errors.length > 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Không thể hủy trực thay',
        errors: errors 
      });
    }

    // 4. BẮT ĐẦU TRANSACTION
    await db.query('START TRANSACTION');

    try {
      // 5. XÓA LỊCH TRỰC ẢO (của người trực thay)
      await db.query('DELETE FROM lich_truc WHERE id = ?', [trucThay.lich_truc_ao_id]);
      console.log(`✅ Đã xóa lịch trực ảo ID: ${trucThay.lich_truc_ao_id}`);

      // 6. XÓA BẢN GHI TRỰC THAY
      await db.query('DELETE FROM truc_thay WHERE id = ?', [trucThay.id]);
      console.log(`✅ Đã xóa bản ghi trực thay ID: ${trucThay.id}`);

      // 7. KHÔI PHỤC LỊCH TRỰC GỐC VỀ TRẠNG THÁI BAN ĐẦU
      // 7.1. Xóa ghi chú trực thay (nếu có)
      let cleanedGhiChu = null;
      if (trucThay.ghi_chu_goc) {
        // Loại bỏ phần ghi chú về trực thay
        const ghiChu = trucThay.ghi_chu_goc;
        const trucThayNote = `Đang chờ trực thay bởi: ${trucThay.ten_nguoi_thuc_hien} (${trucThay.ma_nguoi_thuc_hien})`;
        const activeTrucThayNote = `Được trực thay bởi: ${trucThay.ten_nguoi_thuc_hien} (${trucThay.ma_nguoi_thuc_hien})`;
        
        if (ghiChu.includes(trucThayNote) || ghiChu.includes(activeTrucThayNote)) {
          cleanedGhiChu = ghiChu.replace(trucThayNote, '').replace(activeTrucThayNote, '').trim();
          // Loại bỏ các ký tự thừa
          cleanedGhiChu = cleanedGhiChu.replace(/\s*\|\s*/g, ' | ').replace(/^\|\s*|\s*\|$/g, '');
          if (cleanedGhiChu === '' || cleanedGhiChu === '|') {
            cleanedGhiChu = null;
          }
        }
      }

      // 7.2. Cập nhật lịch gốc - XÓA GHI CHÚ TRỰC THAY
      await db.query(
        `UPDATE lich_truc 
         SET ghi_chu = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [cleanedGhiChu, trucThay.lich_truc_goc_id]
      );

      console.log(`✅ Đã khôi phục lịch trực gốc ID: ${trucThay.lich_truc_goc_id}`);

      // 8. TẠO THÔNG BÁO CHO NGƯỜI ĐĂNG KÝ GỐC
      await db.query(
        `INSERT INTO thong_bao_truc_thay 
         (nguoi_nhan_id, nguoi_gui_id, lich_truc_id, noi_dung, loai) 
         VALUES (?, ?, ?, ?, 'cancel')`,
        [
          trucThay.nguoi_dang_ky_id,
          requester.id,
          trucThay.lich_truc_goc_id,
          `${requester.ten_nhan_vien} (${ma_nhan_vien}) đã hủy trực thay ca ${trucThay.ca_goc} ngày ${new Date(trucThay.ngay_goc).toLocaleDateString('vi-VN')}. Ca đã được trả về trạng thái ban đầu.`
        ]
      );

      await db.query('COMMIT');
      console.log('✅ TRANSACTION thành công');

      // 9. TRẢ VỀ THÔNG TIN SAU KHI HỦY
      const [updatedSchedule] = await db.query(
        `SELECT lt.*, nv.ten_nhan_vien, nv.ma_nhan_vien 
         FROM lich_truc lt 
         JOIN nhanvien nv ON lt.nhan_vien_id = nv.id 
         WHERE lt.id = ?`,
        [trucThay.lich_truc_goc_id]
      );

      const restoredSchedule = updatedSchedule[0] ? {
        id: updatedSchedule[0].id,
        ngay: formatDateLocal(updatedSchedule[0].ngay),
        ca: updatedSchedule[0].ca,
        trang_thai: updatedSchedule[0].trang_thai,
        ten_nhan_vien: updatedSchedule[0].ten_nhan_vien,
        ma_nhan_vien: updatedSchedule[0].ma_nhan_vien,
        ghi_chu: updatedSchedule[0].ghi_chu
      } : null;

      res.json({
        success: true,
        message: 'Đã hủy trực thay thành công',
        important_note: `✅ Lịch trực đã được khôi phục về ${trucThay.ten_nguoi_dang_ky} (${trucThay.ma_nguoi_dang_ky})`,
        data: {
          truc_thay_id: trucThay.id,
          lich_truc_goc_id: trucThay.lich_truc_goc_id,
          lich_truc_ao_id: trucThay.lich_truc_ao_id,
          restored_schedule: restoredSchedule,
          nguoi_dang_ky: {
            ten: trucThay.ten_nguoi_dang_ky,
            ma: trucThay.ma_nguoi_dang_ky
          },
          nguoi_truc_thay: {
            ten: trucThay.ten_nguoi_thuc_hien,
            ma: trucThay.ma_nguoi_thuc_hien
          }
        }
      });

    } catch (error) {
      await db.query('ROLLBACK');
      console.error('❌ Transaction lỗi:', error);
      throw error;
    }

  } catch (error) {
    console.error('❌ Lỗi hủy trực thay (Backend):', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi hủy trực thay',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================
// API: Lấy danh sách ca trực thay của tôi (FIXED VERSION)
// ======================
router.get('/truc-thay/my-shifts', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;

  try {
    console.log('=== LẤY CA TRỰC THAY CỦA:', ma_nhan_vien);

    // 1. Lấy ID nhân viên
    const [employeeRows] = await db.query(
      'SELECT id FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );
    
    if (employeeRows.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Nhân viên không tồn tại' 
      });
    }
    
    const employee_id = employeeRows[0].id;

    // 2. Lấy danh sách ca trực thay (QUERY ĐƠN GIẢN HÓA)
    const [rows] = await db.query(
      `SELECT 
        lt.id,
        lt.ngay,
        lt.ca,
        lt.trang_thai,
        lt.gio_vao,
        lt.gio_ra,
        lt.thoi_gian_lam,
        lt.ghi_chu,
        tt.ly_do,
        tt.created_at as thoi_gian_truc_thay,
        tt.trang_thai as trang_thai_truc_thay,
        nv_original.ten_nhan_vien AS ten_nguoi_dang_ky,
        nv_original.ma_nhan_vien AS ma_nguoi_dang_ky,
        tt.lich_truc_goc_id
      FROM lich_truc lt
      INNER JOIN truc_thay tt ON lt.id = tt.lich_truc_ao_id
      INNER JOIN nhanvien nv_original ON tt.nguoi_dang_ky_id = nv_original.id
      WHERE tt.nguoi_thuc_hien_id = ?
        AND tt.trang_thai IN ('active', 'pending')
      ORDER BY lt.ngay DESC, lt.ca ASC`,
      [employee_id]
    );

    console.log(`✅ Tìm thấy ${rows.length} ca trực thay`);

    // 3. Format lại dữ liệu
    const formattedRows = rows.map(row => {
      // Parse thông tin từ ghi chú
      let originalScheduleId = null;
      if (row.ghi_chu && row.ghi_chu.includes('Lịch gốc ID:')) {
        const match = row.ghi_chu.match(/Lịch gốc ID:\s*(\d+)/);
        if (match) originalScheduleId = parseInt(match[1]);
      }

      return {
        id: row.id,
        ngay: row.ngay ? formatDateLocal(row.ngay) : null,
        ca: row.ca,
        trang_thai: row.trang_thai,
        gio_vao: row.gio_vao,
        gio_ra: row.gio_ra,
        thoi_gian_lam: row.thoi_gian_lam,
        ly_do: row.ly_do,
        thoi_gian_truc_thay: row.thoi_gian_truc_thay,
        ten_nguoi_dang_ky: row.ten_nguoi_dang_ky,
        ma_nguoi_dang_ky: row.ma_nguoi_dang_ky,
        lich_truc_goc_id: row.lich_truc_goc_id || originalScheduleId,
        ghi_chu: row.ghi_chu,
        trang_thai_truc_thay: row.trang_thai_truc_thay,
        is_truc_thay: true
      };
    });

    res.json({
      success: true,
      data: formattedRows,
      count: formattedRows.length
    });

  } catch (error) {
    console.error('❌ Lỗi lấy ca trực thay:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi lấy ca trực thay',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================
// API: Kiểm tra có thể trực thay không (FIXED VERSION)
// ======================
router.get('/truc-thay/check/:lich_truc_id', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const { lich_truc_id } = req.params;

  try {
    console.log('=== KIỂM TRA TRỰC THAY ===');
    console.log('Người kiểm tra:', ma_nhan_vien);
    console.log('Lịch trực ID:', lich_truc_id);

    // 1. Lấy thông tin người kiểm tra
    const [requesterRows] = await db.query(
      'SELECT id FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );
    
    if (requesterRows.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Người kiểm tra không tồn tại' 
      });
    }
    
    const requester_id = requesterRows[0].id;

    // 2. Lấy thông tin lịch trực
    const [scheduleRows] = await db.query(
      `SELECT lt.*, nv.ten_nhan_vien, nv.ma_nhan_vien, nv.id as nhan_vien_id 
       FROM lich_truc lt 
       JOIN nhanvien nv ON lt.nhan_vien_id = nv.id 
       WHERE lt.id = ?`,
      [lich_truc_id]
    );
    
    if (scheduleRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Không tìm thấy lịch trực' 
      });
    }

    const schedule = scheduleRows[0];
    const original_owner_id = schedule.nhan_vien_id;

    // 3. Kiểm tra các điều kiện
    const errors = [];
    const warnings = [];

    // Không thể trực thay cho chính mình
    if (requester_id === original_owner_id) {
      errors.push('Không thể trực thay cho chính mình');
    }

    // Chỉ được trực thay khi ca chưa bắt đầu
    if (schedule.trang_thai !== 'registered') {
      errors.push('Chỉ có thể trực thay khi ca chưa bắt đầu');
    }

    // Kiểm tra người trực thay có trùng lịch không
    const [conflictSchedule] = await db.query(
      `SELECT id FROM lich_truc 
       WHERE ngay = ? 
         AND ca = ? 
         AND nhan_vien_id = ? 
         AND trang_thai != 'checked_out'`,
      [schedule.ngay, schedule.ca, requester_id]
    );
    
    if (conflictSchedule.length > 0) {
      errors.push('Bạn đã có lịch vào thời gian này');
    }

    // Kiểm tra xem ca này đã được trực thay chưa
    const [existingTrucThay] = await db.query(
      `SELECT tt.*, nv.ten_nhan_vien as nguoi_truc_thay 
       FROM truc_thay tt 
       JOIN nhanvien nv ON tt.nguoi_thuc_hien_id = nv.id
       WHERE tt.lich_truc_goc_id = ? AND tt.trang_thai IN ('active', 'pending')`,
      [lich_truc_id]
    );
    
    if (existingTrucThay.length > 0) {
      const trucThay = existingTrucThay[0];
      const statusText = trucThay.trang_thai === 'pending' ? 'đang chờ duyệt' : 'đã được';
      errors.push(`Ca này đã ${statusText} ${trucThay.nguoi_truc_thay} trực thay`);
    }

    // Kiểm tra số lượng người trong ca
    const [userCount] = await db.query(
      'SELECT COUNT(*) as count FROM lich_truc WHERE ngay = ? AND ca = ?',
      [schedule.ngay, schedule.ca]
    );
    
    if (userCount[0].count >= 6) {
      warnings.push('Ca đã đủ số lượng người (6 người)');
    }

    res.json({
      success: errors.length === 0,
      can_truc_thay: errors.length === 0,
      errors: errors,
      warnings: warnings,
      schedule_info: {
        id: schedule.id,
        ngay: schedule.ngay,
        ca: schedule.ca,
        ten_nguoi_dang_ky: schedule.ten_nhan_vien,
        ma_nguoi_dang_ky: schedule.ma_nhan_vien,
        trang_thai: schedule.trang_thai
      }
    });

  } catch (error) {
    console.error('❌ Lỗi kiểm tra trực thay:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi kiểm tra trực thay',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================
// API: Check-in cho ca trực thay (FIXED VERSION)
// ======================
router.post('/truc-thay/checkin/:lich_truc_ao_id', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const { lich_truc_ao_id } = req.params;
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);

  console.log('=== CHECK-IN TRỰC THAY ===');
  console.log('Người check-in:', { ma_nhan_vien, ten_nhan_vien });
  console.log('Lịch ảo ID:', lich_truc_ao_id);

  try {
    // 1. Kiểm tra xem có phải là ca trực thay không
    const [virtualScheduleRows] = await db.query(
      `SELECT lt.*, tt.lich_truc_goc_id, tt.nguoi_dang_ky_id, nv.ten_nhan_vien as ten_nguoi_dang_ky
       FROM lich_truc lt
       INNER JOIN truc_thay tt ON lt.id = tt.lich_truc_ao_id
       INNER JOIN nhanvien nv ON tt.nguoi_dang_ky_id = nv.id
       WHERE lt.id = ? AND lt.nhan_vien_id = (
         SELECT id FROM nhanvien WHERE ma_nhan_vien = ?
       ) AND tt.trang_thai = 'active'`,
      [lich_truc_ao_id, ma_nhan_vien]
    );

    if (virtualScheduleRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Không tìm thấy ca trực thay hoặc không có quyền hoặc chưa được duyệt' 
      });
    }

    const virtualSchedule = virtualScheduleRows[0];
    const lich_truc_goc_id = virtualSchedule.lich_truc_goc_id;
    const ten_nguoi_dang_ky = virtualSchedule.ten_nguoi_dang_ky;

    console.log('Thông tin trực thay:', {
      lịch_gốc_id: lich_truc_goc_id,
      người_đăng_ký: ten_nguoi_dang_ky,
      trạng_thái: virtualSchedule.trang_thai
    });

    // 2. Kiểm tra trạng thái
    if (virtualSchedule.trang_thai === 'checked_out') {
      return res.status(400).json({ 
        success: false,
        message: 'Ca này đã hoàn thành' 
      });
    }
    
    if (virtualSchedule.trang_thai === 'checked_in') {
      return res.status(400).json({ 
        success: false,
        message: 'Bạn đã check-in rồi' 
      });
    }

    // 3. BẮT ĐẦU TRANSACTION
    await db.query('START TRANSACTION');

    try {
      // 4. Check-in lịch ảo
      await db.query(
        'UPDATE lich_truc SET trang_thai = ?, gio_vao = ?, updated_at = NOW() WHERE id = ?',
        ['checked_in', currentTime, lich_truc_ao_id]
      );

      console.log('✅ Đã check-in lịch ảo');

      // 5. Check-in lịch gốc (đồng bộ)
      await db.query(
        'UPDATE lich_truc SET trang_thai = ?, gio_vao = ?, updated_at = NOW() WHERE id = ?',
        ['checked_in', currentTime, lich_truc_goc_id]
      );

      console.log('✅ Đã đồng bộ check-in lịch gốc');

      await db.query('COMMIT');

      res.json({
        success: true,
        message: `Check-in trực thay thành công cho ${ten_nguoi_dang_ky}`,
        note: `⚠️ Số giờ làm sẽ được tính cho ${ten_nguoi_dang_ky}`,
        data: {
          lich_truc_ao_id: lich_truc_ao_id,
          lich_truc_goc_id: lich_truc_goc_id,
          gio_vao: currentTime,
          nguoi_duoc_truc_thay: ten_nguoi_dang_ky
        }
      });

    } catch (error) {
      await db.query('ROLLBACK');
      console.error('❌ Transaction lỗi:', error);
      throw error;
    }

  } catch (error) {
    console.error('❌ Lỗi check-in trực thay:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi check-in trực thay',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================
// API: Check-out cho ca trực thay (FIXED VERSION)
// ======================
router.post('/truc-thay/checkout/:lich_truc_ao_id', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const { lich_truc_ao_id } = req.params;
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);

  console.log('=== CHECK-OUT TRỰC THAY ===');

  try {
    // 1. Kiểm tra xem có phải là ca trực thay không
    const [virtualScheduleRows] = await db.query(
      `SELECT lt.*, tt.lich_truc_goc_id, tt.nguoi_dang_ky_id, nv.ten_nhan_vien as ten_nguoi_dang_ky
       FROM lich_truc lt
       INNER JOIN truc_thay tt ON lt.id = tt.lich_truc_ao_id
       INNER JOIN nhanvien nv ON tt.nguoi_dang_ky_id = nv.id
       WHERE lt.id = ? AND lt.nhan_vien_id = (
         SELECT id FROM nhanvien WHERE ma_nhan_vien = ?
       ) AND tt.trang_thai = 'active'`,
      [lich_truc_ao_id, ma_nhan_vien]
    );

    if (virtualScheduleRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Không tìm thấy ca trực thay hoặc không có quyền hoặc chưa được duyệt' 
      });
    }

    const virtualSchedule = virtualScheduleRows[0];
    const lich_truc_goc_id = virtualSchedule.lich_truc_goc_id;
    const ten_nguoi_dang_ky = virtualSchedule.ten_nguoi_dang_ky;

    // 2. Kiểm tra trạng thái
    if (virtualSchedule.trang_thai !== 'checked_in') {
      return res.status(400).json({ 
        success: false,
        message: 'Bạn cần check-in trước khi check-out' 
      });
    }

    // 3. Tính thời gian làm việc
    const checkInTime = virtualSchedule.gio_vao ? 
      new Date(`${new Date().toISOString().split('T')[0]}T${virtualSchedule.gio_vao}`) : now;
    const checkOutTime = new Date(`${new Date().toISOString().split('T')[0]}T${currentTime}`);
    const workDuration = Math.max(0, (checkOutTime - checkInTime) / (1000 * 60 * 60));

    console.log('Thời gian làm việc:', {
      vào: virtualSchedule.gio_vao,
      ra: currentTime,
      tổng: workDuration.toFixed(2) + ' giờ'
    });

    // 4. BẮT ĐẦU TRANSACTION
    await db.query('START TRANSACTION');

    try {
      // 5. Check-out lịch ảo
      await db.query(
        'UPDATE lich_truc SET trang_thai = ?, gio_ra = ?, thoi_gian_lam = ?, updated_at = NOW() WHERE id = ?',
        ['checked_out', currentTime, workDuration.toFixed(2), lich_truc_ao_id]
      );

      // 6. Check-out lịch gốc (đồng bộ)
      await db.query(
        'UPDATE lich_truc SET trang_thai = ?, gio_ra = ?, thoi_gian_lam = ?, updated_at = NOW() WHERE id = ?',
        ['checked_out', currentTime, workDuration.toFixed(2), lich_truc_goc_id]
      );

      // 7. Cập nhật trạng thái trực thay
      await db.query(
        'UPDATE truc_thay SET trang_thai = "completed", updated_at = NOW() WHERE lich_truc_ao_id = ?',
        [lich_truc_ao_id]
      );

      await db.query('COMMIT');

      res.json({
        success: true,
        message: `Check-out thành công! Đã làm được ${workDuration.toFixed(2)} giờ cho ${ten_nguoi_dang_ky}`,
        note: `✅ Số giờ làm đã được tính cho ${ten_nguoi_dang_ky}`,
        data: {
          lich_truc_ao_id: lich_truc_ao_id,
          lich_truc_goc_id: lich_truc_goc_id,
          gio_ra: currentTime,
          thoi_gian_lam: workDuration.toFixed(2),
          nguoi_duoc_truc_thay: ten_nguoi_dang_ky
        }
      });

    } catch (error) {
      await db.query('ROLLBACK');
      console.error('❌ Transaction lỗi:', error);
      throw error;
    }

  } catch (error) {
    console.error('❌ Lỗi check-out trực thay:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi check-out trực thay',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================
// API: Gửi yêu cầu điều chỉnh giờ (check-in hoặc check-out)
// ======================
router.post('/schedule/:id/request-time-adjustment', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const { id } = req.params;
  const { loai_yeu_cau, thoi_gian_de_xuat, ly_do } = req.body;

  console.log('=== YÊU CẦU ĐIỀU CHỈNH GIỜ ===');
  console.log('Người yêu cầu:', { ma_nhan_vien, ten_nhan_vien });
  console.log('Lịch trực ID:', id);
  console.log('Loại yêu cầu:', loai_yeu_cau);
  console.log('Thời gian đề xuất:', thoi_gian_de_xuat);
  console.log('Lý do:', ly_do);

  try {
    // 1. Lấy thông tin lịch trực
    const [rows] = await db.query('SELECT * FROM lich_truc WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Không tìm thấy ca đăng ký' 
      });
    }
    
    const record = rows[0];
    
    // 2. Kiểm tra quyền
    if (record.ma_nhan_vien !== ma_nhan_vien) {
      return res.status(403).json({ 
        success: false,
        message: 'Bạn không có quyền yêu cầu điều chỉnh ca này' 
      });
    }
    
    // 3. Kiểm tra trạng thái
    if (record.trang_thai === 'checked_out') {
      return res.status(400).json({ 
        success: false,
        message: 'Ca này đã hoàn thành' 
      });
    }
    
    // 4. Kiểm tra loại yêu cầu hợp lệ
    if (loai_yeu_cau === 'checkin' && record.trang_thai === 'checked_in') {
      return res.status(400).json({ 
        success: false,
        message: 'Bạn đã check-in rồi' 
      });
    }
    
    if (loai_yeu_cau === 'checkout' && record.trang_thai !== 'checked_in') {
      return res.status(400).json({ 
        success: false,
        message: 'Bạn cần check-in trước khi yêu cầu điều chỉnh giờ check-out' 
      });
    }
    
    // 5. Kiểm tra xem đã có yêu cầu chờ duyệt chưa
    const [existingRequest] = await db.query(
      'SELECT id FROM yeu_cau_dieu_chinh_gio WHERE lich_truc_id = ? AND trang_thai = "pending"',
      [id]
    );
    
    if (existingRequest.length > 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Đã có yêu cầu điều chỉnh đang chờ duyệt cho ca này' 
      });
    }
    
    // 6. Lấy thông tin nhân viên
    const [empRows] = await db.query('SELECT id FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (empRows.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Nhân viên không tồn tại' 
      });
    }
    const nhan_vien_id = empRows[0].id;
    
    // Tính số ngày trễ (nếu có)
    const currentDate = new Date().toISOString().split('T')[0];
    const recordDate = new Date(record.ngay).toISOString().split('T')[0];
    let daysLate = 0;
    if (recordDate < currentDate) {
      const diffTime = Math.abs(new Date() - new Date(record.ngay));
      daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
    
    // 7. Tạo yêu cầu điều chỉnh
    await db.query(
      `INSERT INTO yeu_cau_dieu_chinh_gio 
       (lich_truc_id, nhan_vien_id, ma_nhan_vien, ten_nhan_vien, loai_yeu_cau, 
        thoi_gian_de_xuat, gio_vao_hien_tai, gio_ra_hien_tai, ngay, ca, ly_do, trang_thai) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        id, 
        nhan_vien_id, 
        ma_nhan_vien, 
        ten_nhan_vien, 
        loai_yeu_cau,
        thoi_gian_de_xuat,
        record.gio_vao,
        record.gio_ra,
        record.ngay,
        record.ca,
        ly_do || (daysLate > 0 ? `Quên check-out sau ${daysLate} ngày` : 'Không có lý do')
      ]
    );
    
    // 8. Thêm thông báo cho admin
    try {
      const [adminRows] = await db.query('SELECT id FROM nhanvien WHERE is_admin = 1');
      const loaiText = loai_yeu_cau === 'checkin' ? 'check-in' : 'check-out';
      const lateText = daysLate > 0 ? ` (trễ ${daysLate} ngày)` : '';
      
      for (const admin of adminRows) {
        await db.query(
          `INSERT INTO thong_bao_truc_thay 
           (nguoi_nhan_id, nguoi_gui_id, lich_truc_id, noi_dung, loai) 
           VALUES (?, ?, ?, ?, ?)`,
          [
            admin.id,
            nhan_vien_id,
            id,
            `${ten_nhan_vien} (${ma_nhan_vien}) đã gửi yêu cầu điều chỉnh giờ ${loaiText}${lateText} ca ${record.ca} ngày ${new Date(record.ngay).toLocaleDateString('vi-VN')}. Thời gian đề xuất: ${thoi_gian_de_xuat}. Lý do: ${ly_do || 'Không có lý do'}`,
            loai_yeu_cau === 'checkin' ? 'checkin_request' : 'checkout_request'
          ]
        );
      }
    } catch (notifyError) {
      console.error('Lỗi gửi thông báo:', notifyError);
      // Không throw error vẫn tiếp tục
    }
    
    const lateMessage = daysLate > 0 ? ` (trễ ${daysLate} ngày)` : '';
    res.json({
      success: true,
      message: `Đã gửi yêu cầu điều chỉnh giờ ${loai_yeu_cau === 'checkin' ? 'check-in' : 'check-out'}${lateMessage} thành công. Vui lòng chờ admin duyệt.`,
      data: {
        lich_truc_id: id,
        loai_yeu_cau: loai_yeu_cau,
        thoi_gian_de_xuat: thoi_gian_de_xuat,
        trang_thai: 'pending',
        days_late: daysLate
      }
    });
    
  } catch (error) {
    console.error('Lỗi gửi yêu cầu điều chỉnh:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi gửi yêu cầu điều chỉnh',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================
// ADMIN API: Lấy danh sách yêu cầu điều chỉnh giờ (tất cả trạng thái)
// ======================
router.get('/admin/time-adjustments', auth, requireAdmin, async (req, res) => {
  const { trang_thai, month, year } = req.query;
  
  let query = `
    SELECT 
      yc.*,
      -- Thông tin lịch trực
      lt.trang_thai as trang_thai_lich,
      lt.gio_vao as gio_vao_hien_tai,
      lt.gio_ra as gio_ra_hien_tai,
      lt.thoi_gian_lam as thoi_gian_lam_hien_tai,
      
      -- Thông tin ca
      CASE yc.ca
        WHEN 'ca1' THEN 'Ca 1: 7:00-9:30'
        WHEN 'ca2' THEN 'Ca 2: 9:30-12:30'
        WHEN 'ca3' THEN 'Ca 3: 12:30-15:00'
        WHEN 'ca4' THEN 'Ca 4: 15:00-17:30'
      END as ten_ca,
      
      -- Thông tin ca chuẩn
      CASE yc.ca
        WHEN 'ca1' THEN '09:30'
        WHEN 'ca2' THEN '12:30'
        WHEN 'ca3' THEN '15:00'
        WHEN 'ca4' THEN '17:30'
      END as gio_ket_thuc_ca,
      
      -- Thời gian chênh lệch
      CASE 
        WHEN yc.loai_yeu_cau = 'checkout' THEN
          TIMEDIFF(yc.thoi_gian_de_xuat, 
            CASE yc.ca
              WHEN 'ca1' THEN '09:30'
              WHEN 'ca2' THEN '12:30'
              WHEN 'ca3' THEN '15:00'
              WHEN 'ca4' THEN '17:30'
            END
          )
        ELSE NULL
      END as thoi_gian_qua_gio
      
    FROM yeu_cau_dieu_chinh_gio yc
    INNER JOIN lich_truc lt ON yc.lich_truc_id = lt.id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (trang_thai) {
    query += ' AND yc.trang_thai = ?';
    params.push(trang_thai);
  }
  
  if (month && year) {
    query += ' AND MONTH(yc.ngay) = ? AND YEAR(yc.ngay) = ?';
    params.push(month, year);
  }
  
  query += ' ORDER BY yc.created_at DESC';

  try {
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy yêu cầu điều chỉnh:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: Lấy danh sách yêu cầu điều chỉnh giờ chờ duyệt
// ======================
router.get('/admin/pending-time-adjustments', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        yc.*,
        -- Thông tin lịch trực
        lt.trang_thai as trang_thai_lich,
        lt.gio_vao as gio_vao_hien_tai,
        lt.gio_ra as gio_ra_hien_tai,
        lt.thoi_gian_lam as thoi_gian_lam_hien_tai,
        
        -- Thông tin ca
        CASE yc.ca
          WHEN 'ca1' THEN 'Ca 1: 7:00-9:30'
          WHEN 'ca2' THEN 'Ca 2: 9:30-12:30'
          WHEN 'ca3' THEN 'Ca 3: 12:30-15:00'
          WHEN 'ca4' THEN 'Ca 4: 15:00-17:30'
        END as ten_ca,
        
        -- Thời gian quá giờ (cho check-out)
        CASE 
          WHEN yc.loai_yeu_cau = 'checkout' THEN
            TIMEDIFF(yc.thoi_gian_de_xuat, 
              CASE yc.ca
                WHEN 'ca1' THEN '09:30'
                WHEN 'ca2' THEN '12:30'
                WHEN 'ca3' THEN '15:00'
                WHEN 'ca4' THEN '17:30'
              END
            )
          ELSE NULL
        END as thoi_gian_qua_gio
      FROM yeu_cau_dieu_chinh_gio yc
      INNER JOIN lich_truc lt ON yc.lich_truc_id = lt.id
      WHERE yc.trang_thai = 'pending'
      ORDER BY yc.created_at DESC`
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy yêu cầu điều chỉnh:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ADMIN API: Duyệt/từ chối yêu cầu điều chỉnh giờ (ĐÃ SỬA)
// ======================
// ======================
// ADMIN API: Duyệt/từ chối yêu cầu điều chỉnh giờ (ĐÃ SỬA LỖI)
// ======================
router.post('/admin/time-adjustment/:id/process', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { approve, thoi_gian_dieu_chinh, ghi_chu_admin } = req.body;
  const admin_id = req.employee.id;

  console.log('=== XỬ LÝ YÊU CẦU ĐIỀU CHỈNH GIỜ ===');
  console.log('Yêu cầu ID:', id);
  console.log('Duyệt:', approve);
  console.log('Thời gian điều chỉnh:', thoi_gian_dieu_chinh);
  console.log('Ghi chú admin:', ghi_chu_admin);

  // Kiểm tra tham số đầu vào
  if (!id) {
    return res.status(400).json({ 
      success: false,
      message: 'Thiếu ID yêu cầu' 
    });
  }

  try {
    // 1. Lấy thông tin yêu cầu
    const [requestRows] = await db.query(
      'SELECT * FROM yeu_cau_dieu_chinh_gio WHERE id = ?',
      [id]
    );

    if (requestRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Không tìm thấy yêu cầu điều chỉnh' 
      });
    }

    const request = requestRows[0];
    
    // Kiểm tra trạng thái yêu cầu
    if (request.trang_thai !== 'pending') {
      return res.status(400).json({ 
        success: false,
        message: `Yêu cầu đã được xử lý (${request.trang_thai})` 
      });
    }
    
    // ===== XỬ LÝ AN TOÀN NGÀY THÁNG =====
    // Tạo một object copy để không ảnh hưởng đến request gốc
    const requestData = { ...request };
    
    // Xử lý trường ngay để tránh lỗi toISOString
    let ngayFormatted = request.ngay;
    
    // Nếu request.ngay là Date object
    if (request.ngay instanceof Date) {
      ngayFormatted = request.ngay.toISOString().split('T')[0];
    } 
    // Nếu request.ngay là string
    else if (typeof request.ngay === 'string') {
      // Giữ nguyên hoặc parse nếu cần
      ngayFormatted = request.ngay;
    }
    // Nếu request.ngay là số (timestamp)
    else if (typeof request.ngay === 'number') {
      ngayFormatted = new Date(request.ngay).toISOString().split('T')[0];
    }
    
    // Gán lại giá trị đã xử lý
    requestData.ngay = ngayFormatted;
    
    // 2. BẮT ĐẦU TRANSACTION
    await db.query('START TRANSACTION');

    try {
      if (approve) {
        // Duyệt: cập nhật lịch trực dựa trên loại yêu cầu
        const thoi_gian = thoi_gian_dieu_chinh || request.thoi_gian_de_xuat;
        
        if (!thoi_gian) {
          throw new Error('Thiếu thời gian điều chỉnh');
        }
        
        if (request.loai_yeu_cau === 'checkin') {
          // Yêu cầu check-in: cập nhật giờ vào
          await db.query(
            `UPDATE lich_truc 
             SET gio_vao = ?, 
                 trang_thai = 'checked_in',
                 updated_at = NOW(),
                 ghi_chu = CONCAT(COALESCE(ghi_chu, ''), ' | Admin điều chỉnh check-in: ', ?, ' - Lý do: ', ?)
             WHERE id = ?`,
            [
              thoi_gian,
              thoi_gian,
              request.ly_do || 'Không có lý do',
              request.lich_truc_id
            ]
          );
          
          console.log(`✅ Đã cập nhật check-in cho lịch trực ID: ${request.lich_truc_id}`);
          
        } else {
          // Yêu cầu check-out: cập nhật giờ ra và tính thời gian làm
          // Lấy thông tin lịch trực hiện tại
          const [lichTrucRows] = await db.query(
            'SELECT * FROM lich_truc WHERE id = ?',
            [request.lich_truc_id]
          );
          
          if (lichTrucRows.length === 0) {
            throw new Error('Không tìm thấy lịch trực');
          }
          
          const lichTruc = lichTrucRows[0];
          
          // Tính thời gian làm việc
          let workDuration = 0;
          if (lichTruc.gio_vao) {
            // SỬ DỤNG requestData.ngay thay vì request.ngay.toISOString()
            const checkInTime = new Date(`${requestData.ngay}T${lichTruc.gio_vao}`);
            const checkOutTime = new Date(`${requestData.ngay}T${thoi_gian}`);
            workDuration = Math.max(0, (checkOutTime - checkInTime) / (1000 * 60 * 60));
          }
          
          await db.query(
            `UPDATE lich_truc 
             SET gio_ra = ?, 
                 thoi_gian_lam = ?, 
                 trang_thai = 'checked_out',
                 updated_at = NOW(),
                 ghi_chu = CONCAT(COALESCE(ghi_chu, ''), ' | Admin điều chỉnh check-out: ', ?, ' - Thời gian làm: ', ?, 'h - Lý do: ', ?)
             WHERE id = ?`,
            [
              thoi_gian,
              workDuration.toFixed(2),
              thoi_gian,
              workDuration.toFixed(2),
              request.ly_do || 'Không có lý do',
              request.lich_truc_id
            ]
          );
          
          console.log(`✅ Đã cập nhật check-out cho lịch trực ID: ${request.lich_truc_id}`);
        }
        
        // Cập nhật yêu cầu
        await db.query(
          `UPDATE yeu_cau_dieu_chinh_gio 
           SET trang_thai = 'approved', 
               admin_duyet_id = ?, 
               thoi_gian_dieu_chinh = ?,
               ghi_chu_admin = ?,
               updated_at = NOW()
           WHERE id = ?`,
          [admin_id, thoi_gian, ghi_chu_admin || null, id]
        );
        
        console.log(`✅ Đã cập nhật yêu cầu ID: ${id} thành approved`);
        
        // Tạo thông báo cho nhân viên (nếu có bảng thông báo)
        try {
          const loaiText = request.loai_yeu_cau === 'checkin' ? 'check-in' : 'check-out';
          await db.query(
            `INSERT INTO thong_bao_truc_thay 
             (nguoi_nhan_id, nguoi_gui_id, lich_truc_id, noi_dung, loai) 
             VALUES (?, ?, ?, ?, ?)`,
            [
              request.nhan_vien_id,
              admin_id,
              request.lich_truc_id,
              `Yêu cầu điều chỉnh giờ ${loaiText} của bạn đã được duyệt. Thời gian mới: ${thoi_gian.substring(0, 5)}.`,
              request.loai_yeu_cau === 'checkin' ? 'checkin_request_approved' : 'checkout_request_approved'
            ]
          );
        } catch (notifyError) {
          console.error('Lỗi tạo thông báo (không ảnh hưởng):', notifyError);
        }
        
        await db.query('COMMIT');
        
        res.json({ 
          success: true,
          message: `Đã duyệt yêu cầu và cập nhật thời gian ${request.loai_yeu_cau === 'checkin' ? 'check-in' : 'check-out'}`,
          data: {
            id,
            status: 'approved',
            loai_yeu_cau: request.loai_yeu_cau,
            thoi_gian_moi: thoi_gian
          }
        });
        
      } else {
        // Từ chối: chỉ cập nhật yêu cầu, không thay đổi lịch trực
        await db.query(
          `UPDATE yeu_cau_dieu_chinh_gio 
           SET trang_thai = 'rejected', 
               admin_duyet_id = ?,
               ghi_chu_admin = ?,
               updated_at = NOW()
           WHERE id = ?`,
          [admin_id, ghi_chu_admin || 'Từ chối yêu cầu', id]
        );
        
        console.log(`✅ Đã cập nhật yêu cầu ID: ${id} thành rejected`);
        
        // Tạo thông báo cho nhân viên (nếu có bảng thông báo)
        try {
          const loaiText = request.loai_yeu_cau === 'checkin' ? 'check-in' : 'check-out';
          await db.query(
            `INSERT INTO thong_bao_truc_thay 
             (nguoi_nhan_id, nguoi_gui_id, lich_truc_id, noi_dung, loai) 
             VALUES (?, ?, ?, ?, ?)`,
            [
              request.nhan_vien_id,
              admin_id,
              request.lich_truc_id,
              `Yêu cầu điều chỉnh giờ ${loaiText} của bạn đã bị từ chối. Lý do: ${ghi_chu_admin || 'Không được duyệt'}.`,
              request.loai_yeu_cau === 'checkin' ? 'checkin_request_rejected' : 'checkout_request_rejected'
            ]
          );
        } catch (notifyError) {
          console.error('Lỗi tạo thông báo (không ảnh hưởng):', notifyError);
        }
        
        await db.query('COMMIT');
        
        res.json({ 
          success: true,
          message: 'Đã từ chối yêu cầu điều chỉnh',
          data: { id, status: 'rejected' }
        });
      }
      
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('❌ Transaction lỗi:', error);
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Lỗi xử lý yêu cầu điều chỉnh:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server khi xử lý yêu cầu: ' + error.message 
    });
  }
});

// ======================
// ADMIN API: Lấy chi tiết yêu cầu điều chỉnh theo nhân viên
// ======================
router.get('/admin/employee/:id/time-adjustments', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;
  
  let query = 'SELECT * FROM yeu_cau_dieu_chinh_gio WHERE nhan_vien_id = ?';
  const params = [id];
  
  if (month && year) {
    query += ' AND MONTH(ngay) = ? AND YEAR(ngay) = ?';
    params.push(month, year);
  }
  
  query += ' ORDER BY created_at DESC';

  try {
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy yêu cầu điều chỉnh:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API: Lấy lịch sử yêu cầu điều chỉnh của tôi
// ======================
router.get('/my/time-adjustments', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  
  try {
    const [empRows] = await db.query('SELECT id FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (empRows.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Nhân viên không tồn tại' 
      });
    }
    const nhan_vien_id = empRows[0].id;
    
    const [rows] = await db.query(
      `SELECT 
        yc.*,
        CASE yc.trang_thai
          WHEN 'pending' THEN 'Chờ duyệt'
          WHEN 'approved' THEN 'Đã duyệt'
          WHEN 'rejected' THEN 'Từ chối'
        END as trang_thai_text,
        CASE yc.ca
          WHEN 'ca1' THEN 'Ca 1: 7:00-9:30'
          WHEN 'ca2' THEN 'Ca 2: 9:30-12:30'
          WHEN 'ca3' THEN 'Ca 3: 12:30-15:00'
          WHEN 'ca4' THEN 'Ca 4: 15:00-17:30'
        END as ten_ca,
        CASE yc.loai_yeu_cau
          WHEN 'checkin' THEN 'Check-in'
          WHEN 'checkout' THEN 'Check-out'
        END as ten_loai_yeu_cau
      FROM yeu_cau_dieu_chinh_gio yc
      WHERE yc.nhan_vien_id = ?
      ORDER BY yc.created_at DESC`,
      [nhan_vien_id]
    );
    
    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error('Lỗi lấy lịch sử yêu cầu:', error);
    res.status(500).json({ 
      success: false,
      message: 'Lỗi server' 
    });
  }
});

// ======================
// API XUẤT BÁO CÁO THÁNG RA EXCEL (CÓ GIỜ VÀO, GIỜ RA)
// ======================
router.get('/monthly-report/excel', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const { month, year } = req.query;
  
  const today = new Date();
  const targetMonth = month || today.getMonth() + 1;
  const targetYear = year || today.getFullYear();

  try {
    // Lấy thông tin nhân viên
    const [empRows] = await db.query('SELECT id FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (empRows.length === 0) {
      return res.status(400).json({ message: 'Nhân viên không tồn tại' });
    }
    const nhan_vien_id = empRows[0].id;

    // Lấy dữ liệu chi tiết các ca đã làm trong tháng (CÓ GIỜ VÀO, GIỜ RA)
    const [workRecords] = await db.query(
      `SELECT 
        lt.*,
        DATE(lt.ngay) as ngay_thang,
        nv.ten_nhan_vien,
        nv.ma_nhan_vien
      FROM lich_truc lt
      JOIN nhanvien nv ON lt.nhan_vien_id = nv.id
      WHERE lt.nhan_vien_id = ? 
        AND MONTH(lt.ngay) = ?
        AND YEAR(lt.ngay) = ?
        AND lt.trang_thai = 'checked_out'
        AND lt.thoi_gian_lam IS NOT NULL
      ORDER BY lt.ngay ASC, 
        CASE lt.ca
          WHEN 'ca1' THEN 1
          WHEN 'ca2' THEN 2
          WHEN 'ca3' THEN 3
          WHEN 'ca4' THEN 4
        END`,
      [nhan_vien_id, targetMonth, targetYear]
    );

    // Lấy tổng kết tháng
    const [monthlySummary] = await db.query(
      `SELECT 
        COUNT(DISTINCT DATE(ngay)) as tong_so_ngay,
        COUNT(*) as tong_so_ca,
        SUM(thoi_gian_lam) as tong_thoi_gian_thang
      FROM lich_truc 
      WHERE nhan_vien_id = ? 
        AND MONTH(ngay) = ?
        AND YEAR(ngay) = ?
        AND trang_thai = 'checked_out'
        AND thoi_gian_lam IS NOT NULL`,
      [nhan_vien_id, targetMonth, targetYear]
    );

    // Tạo workbook Excel
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hệ thống chấm công';
    workbook.created = new Date();
    
    // Tạo worksheet chính
    const worksheet = workbook.addWorksheet(`Báo cáo ${targetMonth}/${targetYear}`);
    
    // Định nghĩa các column
    worksheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Ngày làm việc', key: 'ngay', width: 15 },
      { header: 'Thứ', key: 'thu', width: 8 },
      { header: 'Ca làm việc', key: 'ca', width: 20 },
      { header: 'Mã nhân viên', key: 'ma_nhan_vien', width: 12 },
      { header: 'Tên nhân viên', key: 'ten_nhan_vien', width: 25 },
      { header: 'Giờ vào', key: 'gio_vao', width: 10 },
      { header: 'Giờ ra', key: 'gio_ra', width: 10 },
      { header: 'Thời gian làm (giờ)', key: 'thoi_gian_lam', width: 18 },
      { header: 'Thời gian làm (phút)', key: 'thoi_gian_lam_phut', width: 18 },
      { header: 'Trạng thái', key: 'trang_thai', width: 12 },
      { header: 'Ghi chú', key: 'ghi_chu', width: 25 }
    ];

    // Style cho header
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2E7D32' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;

    // Thêm dữ liệu
    let stt = 1;
    
    workRecords.forEach((record, index) => {
      const ngay = new Date(record.ngay_thang);
      const thu = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'][ngay.getDay()];
      
      // Định dạng tên ca
      let caLabel = record.ca;
      switch(record.ca) {
        case 'ca1': caLabel = 'Ca 1: 7:00-9:30'; break;
        case 'ca2': caLabel = 'Ca 2: 9:30-12:30'; break;
        case 'ca3': caLabel = 'Ca 3: 12:30-15:00'; break;
        case 'ca4': caLabel = 'Ca 4: 15:00-17:30'; break;
      }
      
      // Tính thời gian làm theo phút
      const thoiGianLamPhut = Math.round((Number(record.thoi_gian_lam) || 0) * 60);
      
      // Format giờ vào, giờ ra
      const gioVao = record.gio_vao ? 
        (typeof record.gio_vao === 'string' ? record.gio_vao.substring(0, 5) : record.gio_vao) : '';
      const gioRa = record.gio_ra ? 
        (typeof record.gio_ra === 'string' ? record.gio_ra.substring(0, 5) : record.gio_ra) : '';
      
      // Thêm dòng dữ liệu với GIỜ VÀO, GIỜ RA
      worksheet.addRow({
        stt: stt++,
        ngay: ngay.toLocaleDateString('vi-VN'),
        thu: thu,
        ca: caLabel,
        ma_nhan_vien: record.ma_nhan_vien,
        ten_nhan_vien: record.ten_nhan_vien,
        gio_vao: gioVao,
        gio_ra: gioRa,
        thoi_gian_lam: Number(record.thoi_gian_lam).toFixed(2),
        thoi_gian_lam_phut: thoiGianLamPhut,
        trang_thai: 'Hoàn thành',
        ghi_chu: `Ca ${caLabel.split(':')[0]} ngày ${ngay.toLocaleDateString('vi-VN')}`
      });
    });

    // Thêm dòng trống
    worksheet.addRow({});

    // Thêm dòng tổng kết
    const summaryRow = worksheet.addRow({
      ngay: 'TỔNG KẾT THÁNG',
      thu: '',
      ca: '',
      ma_nhan_vien: '',
      ten_nhan_vien: '',
      gio_vao: '',
      gio_ra: '',
      thoi_gian_lam: monthlySummary[0]?.tong_thoi_gian_thang ? 
        Number(monthlySummary[0].tong_thoi_gian_thang).toFixed(2) : '0.00',
      thoi_gian_lam_phut: monthlySummary[0]?.tong_thoi_gian_thang ? 
        Math.round(Number(monthlySummary[0].tong_thoi_gian_thang) * 60) : 0,
      trang_thai: '',
      ghi_chu: `Số ngày làm: ${monthlySummary[0]?.tong_so_ngay || 0}, Số ca: ${monthlySummary[0]?.tong_so_ca || 0}`
    });

    // Style cho dòng tổng kết
    summaryRow.font = { bold: true };
    summaryRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE3F2FD' }
    };

    // Thêm thông tin tiêu đề
    worksheet.insertRows(1, [
      [`BÁO CÁO CHẤM CÔNG THÁNG ${targetMonth}/${targetYear}`],
      [`Nhân viên: ${ten_nhan_vien} (Mã: ${ma_nhan_vien})`],
      [`Ngày xuất báo cáo: ${new Date().toLocaleDateString('vi-VN')}`],
      [] // Dòng trống
    ]);

    // Merge cells cho tiêu đề
    worksheet.mergeCells('A1:L1');
    worksheet.mergeCells('A2:L2');
    worksheet.mergeCells('A3:L3');

    // Style cho tiêu đề
    const titleRow = worksheet.getRow(1);
    titleRow.font = { bold: true, size: 16, color: { argb: 'FF1976D2' } };
    titleRow.alignment = { vertical: 'middle', horizontal: 'center' };
    titleRow.height = 30;

    const subtitleRow = worksheet.getRow(2);
    subtitleRow.font = { bold: true, size: 14 };
    subtitleRow.alignment = { vertical: 'middle', horizontal: 'center' };

    const dateRow = worksheet.getRow(3);
    dateRow.font = { italic: true };
    dateRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Điều chỉnh style cho toàn bộ dữ liệu
    for (let i = 5; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);
      row.alignment = { vertical: 'middle', horizontal: 'center' };
      
      // Tô màu xen kẽ cho các dòng
      if (i >= 5 && i < worksheet.rowCount - 1) {
        if (i % 2 === 0) {
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF5F5F5' }
          };
        }
      }
    }

    // Thiết lập border
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber >= 5) {
        row.eachCell((cell) => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
          };
        });
      }
    });

    // Đặt tên file
    const filename = `BaoCaoChamCong_${ten_nhan_vien.replace(/\s+/g, '_')}_${pad(targetMonth)}_${targetYear}.xlsx`;
    
    // Thiết lập headers để download file
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    // Ghi workbook vào response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Lỗi xuất Excel:', error);
    res.status(500).json({ message: 'Lỗi xuất báo cáo Excel: ' + error.message });
  }
});

// ======================
// BÁO CÁO GIỜ LÀM THÁNG (theo nhân viên hiện tại)
// ======================
router.get('/monthly-hours', auth, async (req, res) => {
  const today = new Date();
  const month = Number(req.query.month || today.getMonth() + 1);
  const year = Number(req.query.year || today.getFullYear());
  const { ma_nhan_vien } = req.employee;

  try {
    // Giờ làm từng ngày
    const [daily] = await db.query(
      `SELECT ngay, COALESCE(SUM(thoi_gian_lam), 0) AS hours
       FROM lich_truc
       WHERE ma_nhan_vien = ?
         AND MONTH(ngay) = ?
         AND YEAR(ngay) = ?
         AND thoi_gian_lam IS NOT NULL
       GROUP BY ngay
       ORDER BY ngay ASC`,
      [ma_nhan_vien, month, year]
    );

    const formattedDaily = daily.map(row => ({
      ngay: row.ngay ? (typeof row.ngay === 'string' ? row.ngay.split('T')[0].split(' ')[0] : formatDateLocal(row.ngay)) : null,
      hours: Number(row.hours || 0),
    }));

    const totalHours = formattedDaily.reduce((sum, d) => sum + d.hours, 0);
    const wagePerHour = 22000;
    const totalWage = totalHours * wagePerHour;

    res.json({
      month,
      year,
      daily: formattedDaily,
      total_hours: totalHours,
      total_wage: totalWage,
      wage_per_hour: wagePerHour,
      threshold_warning: totalHours >= 80 && totalHours < 91,
      threshold_reached: totalHours >= 91,
    });
  } catch (error) {
    console.error('Lỗi lấy thống kê giờ làm tháng:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API: CA ĐÃ ĐĂNG KÝ TRONG NGÀY (CHO NGƯỜI DÙNG HIỆN TẠI)
// ======================
router.get('/my/today-shifts', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const date = req.query.date || new Date().toISOString().split('T')[0];

  try {
    // Lấy tất cả ca trong ngày đó (mọi nhân viên)
    const [allRows] = await db.query(
      `SELECT lt.*, nv.ten_nhan_vien 
       FROM lich_truc lt
       JOIN nhanvien nv ON lt.nhan_vien_id = nv.id
       WHERE DATE(lt.ngay) = ?`,
      [date]
    );

    // Lọc ra các ca của chính nhân viên đang đăng nhập
    const myRows = allRows.filter(row => row.ma_nhan_vien === ma_nhan_vien);

    // Gom thông tin những người cùng ca
    const result = myRows.map(row => {
      const participants = allRows
        .filter(r => r.ngay === row.ngay && r.ca === row.ca)
        .map(r => ({
          nhan_vien_id: r.nhan_vien_id,
          ma_nhan_vien: r.ma_nhan_vien,
          ten_nhan_vien: r.ten_nhan_vien,
          is_me: r.ma_nhan_vien === ma_nhan_vien
        }));

      return {
        id: row.id,
        ngay: row.ngay ? (typeof row.ngay === 'string' ? row.ngay.split('T')[0].split(' ')[0] : formatDateLocal(row.ngay)) : null,
        ca: row.ca,
        trang_thai: row.trang_thai,
        gio_vao: row.gio_vao,
        gio_ra: row.gio_ra,
        thoi_gian_lam: row.thoi_gian_lam,
        participants
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Lỗi lấy ca hôm nay:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// ĐĂNG KÝ LỊCH TRỰC (CÓ KIỂM TRA QUÁ GIỜ)
// ======================
router.post('/schedule/register', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const { date, shift } = req.body;

  if (!['ca1', 'ca2', 'ca3', 'ca4'].includes(shift)) {
    return res.status(400).json({ message: 'Ca không hợp lệ' });
  }

  try {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Lấy thông tin ca
    const shiftInfo = {
      'ca1': { start: '07:00', end: '09:30' },
      'ca2': { start: '09:30', end: '12:30' },
      'ca3': { start: '12:30', end: '15:00' },
      'ca4': { start: '15:00', end: '17:30' }
    };
    
    const { start: shiftStart, end: shiftEnd } = shiftInfo[shift];
    
    // KIỂM TRA 1: QUÁ GIỜ ĐĂNG KÝ
    // Nếu ngày đăng ký là hôm nay và đã qua giờ bắt đầu ca
    if (date === today && currentTime > shiftStart) {
      return res.status(400).json({ 
        message: `Không thể đăng ký ca này vì đã quá giờ bắt đầu (${shiftStart})` 
      });
    }
    
    // Nếu ngày đăng ký là ngày đã qua
    if (date < today) {
      return res.status(400).json({ 
        message: 'Không thể đăng ký ca trong quá khứ' 
      });
    }

    // Lấy thông tin nhân viên
    const [empRows] = await db.query('SELECT id FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (empRows.length === 0) {
      return res.status(400).json({ message: 'Nhân viên không tồn tại' });
    }
    const nhan_vien_id = empRows[0].id;

    // Kiểm tra đã đăng ký chưa
    const [existing] = await db.query(
      'SELECT id FROM lich_truc WHERE ngay = ? AND ca = ? AND nhan_vien_id = ?',
      [date, shift, nhan_vien_id]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Bạn đã đăng ký ca này rồi' });
    }

    // Kiểm tra số lượng người trong ca (tối đa 6)
    const [userCount] = await db.query(
      'SELECT COUNT(*) as count FROM lich_truc WHERE ngay = ? AND ca = ?',
      [date, shift]
    );
    
    if (userCount[0].count >= 6) {
      return res.status(400).json({ message: 'Ca đã đủ số lượng người đăng ký (tối đa 6 người)' });
    }

    // Không cho đăng ký 2 ca liên tiếp trong cùng ngày
    const [existingByUser] = await db.query(
      'SELECT ca FROM lich_truc WHERE ngay = ? AND nhan_vien_id = ?',
      [date, nhan_vien_id]
    );

    if (existingByUser.length > 0) {
      const shiftOrder = ['ca1', 'ca2', 'ca3', 'ca4'];
      const currentIndex = shiftOrder.indexOf(shift);
      const registeredShifts = existingByUser.map(row => row.ca);

      const hasAdjacent = registeredShifts.some(regShift => {
        const regIndex = shiftOrder.indexOf(regShift);
        return Math.abs(currentIndex - regIndex) === 1;
      });

      if (hasAdjacent) {
        return res.status(400).json({ message: 'Không được đăng ký 2 ca liên tiếp trong cùng ngày' });
      }
    }

    // Chặn đăng ký nếu tổng giờ làm trong tháng đã đạt 91h
    const todayDate = new Date(date);
    const currentMonth = todayDate.getMonth() + 1;
    const currentYear = todayDate.getFullYear();
    const totalMonthHours = await getMonthlyHours(ma_nhan_vien, currentMonth, currentYear);
    if (totalMonthHours >= 91) {
      return res.status(400).json({ message: 'Bạn đã đạt tối đa 91 giờ trong tháng, không thể đăng ký thêm' });
    }

    // Thực hiện đăng ký
    const [result] = await db.query(
      'INSERT INTO lich_truc (ngay, ca, nhan_vien_id, ma_nhan_vien, ten_nhan_vien, trang_thai) VALUES (?, ?, ?, ?, ?, ?)',
      [date, shift, nhan_vien_id, ma_nhan_vien, ten_nhan_vien, 'registered']
    );

    // Lấy lại thông tin đăng ký vừa tạo với format ngày đúng
    const [newRecord] = await db.query(
      'SELECT * FROM lich_truc WHERE id = ?',
      [result.insertId]
    );

    const formattedRecord = newRecord[0] ? {
      ...newRecord[0],
      ngay: newRecord[0].ngay ? (typeof newRecord[0].ngay === 'string' ? newRecord[0].ngay.split('T')[0].split(' ')[0] : formatDateLocal(newRecord[0].ngay)) : null
    } : null;

    // Tính lại tổng giờ sau khi đăng ký để cảnh báo gần 91h
    const updatedMonthHours = await getMonthlyHours(ma_nhan_vien, currentMonth, currentYear);
    const warning = updatedMonthHours >= 80 && updatedMonthHours < 91
      ? 'Bạn đã gần đạt tới 91 giờ trong tháng'
      : null;

    res.json({ 
      id: result.insertId, 
      message: 'Đăng ký thành công',
      data: formattedRecord,
      status: 'registered',
      total_month_hours: updatedMonthHours,
      warning
    });
  } catch (error) {
    console.error('Lỗi đăng ký:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// ======================
// CHECK-IN (CÓ KIỂM TRA CHƯA TỚI GIỜ LÀM)
// ======================
router.post('/schedule/:id/checkin', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const { id } = req.params;
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const currentDate = now.toISOString().split('T')[0];

  try {
    const [rows] = await db.query('SELECT * FROM lich_truc WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy ca đăng ký' });
    
    const record = rows[0];
    
    // Kiểm tra quyền
    if (record.ma_nhan_vien !== ma_nhan_vien) {
      return res.status(403).json({ message: 'Bạn không có quyền check-in ca này' });
    }
    
    // Kiểm tra trạng thái
    if (record.trang_thai === 'checked_out') {
      return res.status(400).json({ message: 'Ca này đã hoàn thành' });
    }
    if (record.trang_thai === 'checked_in') {
      return res.status(400).json({ message: 'Bạn đã check-in rồi' });
    }
    
    // Lấy thông tin ca
    const shiftInfo = {
      'ca1': { start: '07:00', end: '09:30' },
      'ca2': { start: '09:30', end: '12:30' },
      'ca3': { start: '12:30', end: '15:00' },
      'ca4': { start: '15:00', end: '17:30' }
    };
    
    const { start: shiftStart, end: shiftEnd } = shiftInfo[record.ca] || { start: '00:00', end: '23:59' };
    const recordDate = new Date(record.ngay).toISOString().split('T')[0];
    
    // KIỂM TRA MỚI: CHƯA TỚI GIỜ LÀM
    // Nếu là ngày hôm nay và chưa tới giờ bắt đầu ca
    if (recordDate === currentDate && currentTime < shiftStart) {
      return res.status(400).json({ 
        message: `Chưa tới giờ làm! Check-in chỉ được thực hiện từ ${shiftStart}` 
      });
    }
    
    // KIỂM TRA QUÁ GIỜ CHECK-IN
    // Nếu là ngày hôm nay
    if (recordDate === currentDate) {
      const [endHours, endMinutes] = shiftEnd.split(':').map(Number);
      const endTimeInMinutes = endHours * 60 + endMinutes;
      
      const [currentHours, currentMinutes] = currentTime.split(':').map(Number);
      const currentTimeInMinutes = currentHours * 60 + currentMinutes;
      
      // Quá 1 giờ so với thời gian kết thúc ca
      if (currentTimeInMinutes > (endTimeInMinutes + 60)) {
        return res.status(400).json({ 
          message: `Đã quá 1 giờ so với thời gian kết thúc ca (${shiftEnd}), không thể check-in. Bạn có thể gửi yêu cầu điều chỉnh giờ.`,
          canRequestAdjustment: true,
          loai_yeu_cau: 'checkin',
          shiftEnd: shiftEnd,
          currentTime: currentTime
        });
      }
    }
    
    // Nếu là ngày trước đó (hôm qua)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    if (recordDate === yesterdayStr) {
      // Kiểm tra nếu đã quá 24h + 1h từ giờ kết thúc ca
      const recordDateTime = new Date(record.ngay);
      const endTime = new Date(recordDateTime);
      const [endHours, endMinutes] = shiftEnd.split(':').map(Number);
      endTime.setHours(endHours, endMinutes, 0);
      
      // Thời gian cho phép = thời gian kết thúc ca + 25 giờ (24h + 1h buffer)
      const allowedUntil = new Date(endTime.getTime() + (25 * 60 * 60 * 1000));
      
      if (now > allowedUntil) {
        return res.status(400).json({ 
          message: 'Đã quá thời gian cho phép check-in (quá 24 giờ sau khi ca kết thúc)' 
        });
      }
    }
    
    // Nếu là ngày trước hôm qua (2+ ngày trước)
    if (recordDate < yesterdayStr) {
      return res.status(400).json({ 
        message: 'Không thể check-in cho ca đã qua 2 ngày trở lên' 
      });
    }

    await db.query(
      'UPDATE lich_truc SET trang_thai = ?, gio_vao = ?, updated_at = NOW() WHERE id = ?',
      ['checked_in', currentTime, id]
    );

    res.json({ 
      message: 'Check-in thành công', 
      status: 'checked_in', 
      time: currentTime,
      record: { ...record, trang_thai: 'checked_in', gio_vao: currentTime }
    });
  } catch (error) {
    console.error('Lỗi check-in:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// CHECK-OUT (CÓ KIỂM TRA CHƯA TỚI GIỜ LÀM) - ĐÃ SỬA
// ======================
router.post('/schedule/:id/checkout', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const { id } = req.params;
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const currentDate = now.toISOString().split('T')[0];

  try {
    const [rows] = await db.query('SELECT * FROM lich_truc WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy ca đăng ký' });
    }
    
    const record = rows[0];
    
    // Kiểm tra quyền
    if (record.ma_nhan_vien !== ma_nhan_vien) {
      return res.status(403).json({ message: 'Bạn không có quyền check-out ca này' });
    }
    
    // Kiểm tra trạng thái
    if (record.trang_thai === 'checked_out') {
      return res.status(400).json({ message: 'Ca này đã hoàn thành' });
    }
    
    if (record.trang_thai !== 'checked_in') {
      return res.status(400).json({ message: 'Bạn cần check-in trước khi check-out' });
    }
    
    // Lấy thông tin ca
    const shiftInfo = {
      'ca1': { start: '07:00', end: '09:30' },
      'ca2': { start: '09:30', end: '12:30' },
      'ca3': { start: '12:30', end: '15:00' },
      'ca4': { start: '15:00', end: '17:30' }
    };
    
    const { start: shiftStart, end: shiftEnd } = shiftInfo[record.ca] || { start: '00:00', end: '23:59' };
    
    // Xử lý ngày an toàn
    let recordDate;
    try {
      if (record.ngay instanceof Date) {
        recordDate = record.ngay.toISOString().split('T')[0];
      } else {
        recordDate = new Date(record.ngay).toISOString().split('T')[0];
      }
    } catch (e) {
      recordDate = currentDate;
    }
    
    // KIỂM TRA 1: CHƯA TỚI NGÀY LÀM
    if (recordDate > currentDate) {
      return res.status(400).json({ 
        message: 'Chưa tới ngày làm! Không thể check-out trước ngày làm việc' 
      });
    }
    
    // KIỂM TRA 2: CHƯA TỚI GIỜ LÀM (chỉ áp dụng nếu là cùng ngày)
    if (recordDate === currentDate && currentTime < shiftStart) {
      return res.status(400).json({ 
        message: `Chưa tới giờ làm! Check-out chỉ được thực hiện từ ${shiftStart}` 
      });
    }
    
    // TÍNH SỐ NGÀY CHÊNH LỆCH
    const diffTime = Math.abs(now - new Date(recordDate));
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    // KIỂM TRA 3: NẾU LÀ NGÀY HÔM NAY
    if (recordDate === currentDate) {
      const [endHours, endMinutes] = shiftEnd.split(':').map(Number);
      const endTimeInMinutes = endHours * 60 + endMinutes;
      
      const [currentHours, currentMinutes] = currentTime.split(':').map(Number);
      const currentTimeInMinutes = currentHours * 60 + currentMinutes;
      
      // Nếu trong giờ làm
      if (currentTimeInMinutes <= endTimeInMinutes) {
        // Check-out bình thường
        console.log('=== CHECK-OUT BÌNH THƯỜNG (cùng ngày, trong giờ) ===');
        const checkInTime = record.gio_vao ? new Date(`${currentDate}T${record.gio_vao}`) : now;
        const checkOutTime = new Date(`${currentDate}T${currentTime}`);
        const workDuration = Math.max(0, (checkOutTime - checkInTime) / (1000 * 60 * 60));

        await db.query(
          'UPDATE lich_truc SET trang_thai = ?, gio_ra = ?, thoi_gian_lam = ?, updated_at = NOW() WHERE id = ?',
          ['checked_out', currentTime, workDuration.toFixed(2), id]
        );

        // Tính tổng thời gian làm trong ngày
        const [totalWorkResult] = await db.query(
          `SELECT SUM(thoi_gian_lam) as tong_thoi_gian
           FROM lich_truc 
           WHERE nhan_vien_id = ? AND ngay = ? AND trang_thai = 'checked_out' AND thoi_gian_lam IS NOT NULL`,
          [record.nhan_vien_id, record.ngay]
        );

        return res.json({
          message: 'Check-out thành công',
          status: 'checked_out',
          workDuration: workDuration.toFixed(2),
          totalWorkTime: totalWorkResult[0]?.tong_thoi_gian || 0,
          time: currentTime,
          record: { 
            ...record, 
            trang_thai: 'checked_out', 
            gio_ra: currentTime, 
            thoi_gian_lam: workDuration.toFixed(2) 
          }
        });
      } 
      
      // Quá giờ trong ngày
      console.log('=== QUÁ GIỜ TRONG NGÀY, CHO PHÉP GỬI YÊU CẦU ===');
      return res.status(400).json({ 
        message: `Đã quá giờ kết thúc ca (${shiftEnd})`,
        canRequestAdjustment: true,
        loai_yeu_cau: 'checkout',
        shiftEnd: shiftEnd,
        daysLate: 0,
        record: record
      });
    }
    
    // KIỂM TRA 4: NẾU LÀ NGÀY QUÁ KHỨ
    if (recordDate < currentDate) {
      console.log('=== CA QUÁ KHỨ, CHO PHÉP GỬI YÊU CẦU ===');
      console.log('Số ngày trễ:', diffDays);
      return res.status(400).json({ 
        message: `Ca này đã qua ${diffDays} ngày. Vui lòng gửi yêu cầu điều chỉnh giờ check-out.`,
        canRequestAdjustment: true,
        loai_yeu_cau: 'checkout',
        shiftEnd: shiftEnd,
        daysLate: diffDays,
        record: record
      });
    }

    // Fallback (không nên xảy ra)
    return res.status(400).json({ 
      message: 'Không thể check-out',
      canRequestAdjustment: true,
      loai_yeu_cau: 'checkout'
    });
    
  } catch (error) {
    console.error('Lỗi check-out:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// LẤY TỔNG THỜI GIAN LÀM VIỆC THEO NGÀY
// ======================
router.get('/daily-summary', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const { date } = req.query; // format: YYYY-MM-DD
  
  if (!date) {
    return res.status(400).json({ message: 'Thiếu tham số ngày' });
  }

  try {
    // Lấy thông tin nhân viên
    const [empRows] = await db.query('SELECT id FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (empRows.length === 0) {
      return res.status(400).json({ message: 'Nhân viên không tồn tại' });
    }
    const nhan_vien_id = empRows[0].id;

    // Lấy tổng thời gian làm việc trong ngày (CÓ GIỜ VÀO, GIỜ RA)
    const [summary] = await db.query(
      `SELECT 
        DATE(ngay) as ngay,
        COUNT(*) as so_ca_da_lam,
        SUM(thoi_gian_lam) as tong_thoi_gian_lam,
        GROUP_CONCAT(CONCAT(ca, ':', thoi_gian_lam, ':', COALESCE(gio_vao, ''), ':', COALESCE(gio_ra, '')) SEPARATOR ';') as chi_tiet_ca
      FROM lich_truc 
      WHERE nhan_vien_id = ? 
        AND DATE(ngay) = ?
        AND trang_thai = 'checked_out'
        AND thoi_gian_lam IS NOT NULL
      GROUP BY DATE(ngay)`,
      [nhan_vien_id, date]
    );

    // Lấy chi tiết các ca đã làm trong ngày (CÓ GIỜ VÀO, GIỜ RA)
    const [details] = await db.query(
      `SELECT 
        id,
        ca,
        gio_vao,
        gio_ra,
        thoi_gian_lam,
        trang_thai,
        created_at
      FROM lich_truc 
      WHERE nhan_vien_id = ? 
        AND DATE(ngay) = ?
      ORDER BY 
        CASE ca
          WHEN 'ca1' THEN 1
          WHEN 'ca2' THEN 2
          WHEN 'ca3' THEN 3
          WHEN 'ca4' THEN 4
        END`,
      [nhan_vien_id, date]
    );

    const result = {
      date: date,
      employee_id: nhan_vien_id,
      ma_nhan_vien: ma_nhan_vien,
      summary: summary[0] || {
        ngay: date,
        so_ca_da_lam: 0,
        tong_thoi_gian_lam: 0,
        chi_tiet_ca: null
      },
      details: details,
      formatted_summary: summary[0] ? {
        ngay: date,
        so_ca_da_lam: summary[0].so_ca_da_lam,
        tong_thoi_gian_lam: Number(summary[0].tong_thoi_gian_lam).toFixed(2),
        tong_thoi_gian_gio: formatHours(Number(summary[0].tong_thoi_gian_lam))
      } : {
        ngay: date,
        so_ca_da_lam: 0,
        tong_thoi_gian_lam: "0.00",
        tong_thoi_gian_gio: "0 giờ 0 phút"
      }
    };

    res.json(result);
  } catch (error) {
    console.error('Lỗi lấy tổng thời gian:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// LẤY BÁO CÁO THỐNG KÊ THEO THÁNG
// ======================
router.get('/monthly-report', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const { month, year } = req.query;
  
  const today = new Date();
  const targetMonth = month || today.getMonth() + 1;
  const targetYear = year || today.getFullYear();

  try {
    // Lấy thông tin nhân viên
    const [empRows] = await db.query('SELECT id FROM nhanvien WHERE ma_nhan_vien = ?', [ma_nhan_vien]);
    if (empRows.length === 0) {
      return res.status(400).json({ message: 'Nhân viên không tồn tại' });
    }
    const nhan_vien_id = empRows[0].id;

    // Lấy báo cáo theo tháng (CÓ GIỜ VÀO, GIỜ RA)
    const [report] = await db.query(
      `SELECT 
        DATE(ngay) as ngay,
        COUNT(*) as so_ca_da_lam,
        SUM(thoi_gian_lam) as tong_thoi_gian_lam,
        GROUP_CONCAT(CONCAT(ca, ':', thoi_gian_lam, ':', COALESCE(gio_vao, ''), ':', COALESCE(gio_ra, '')) SEPARATOR ';') as chi_tiet_ca
      FROM lich_truc 
      WHERE nhan_vien_id = ? 
        AND MONTH(ngay) = ?
        AND YEAR(ngay) = ?
        AND trang_thai = 'checked_out'
        AND thoi_gian_lam IS NOT NULL
      GROUP BY DATE(ngay)
      ORDER BY ngay DESC`,
      [nhan_vien_id, targetMonth, targetYear]
    );

    // Tính tổng tháng
    const monthlyTotal = report.reduce((total, day) => {
      return total + (Number(day.tong_thoi_gian_lam) || 0);
    }, 0);

    const result = {
      month: targetMonth,
      year: targetYear,
      employee_id: nhan_vien_id,
      ma_nhan_vien: ma_nhan_vien,
      daily_reports: report.map(day => ({
        ngay: day.ngay,
        so_ca_da_lam: day.so_ca_da_lam,
        tong_thoi_gian_lam: Number(day.tong_thoi_gian_lam).toFixed(2),
        chi_tiet_ca: day.chi_tiet_ca,
        formatted_time: formatHours(Number(day.tong_thoi_gian_lam))
      })),
      monthly_summary: {
        tong_so_ngay: report.length,
        tong_so_ca: report.reduce((sum, day) => sum + day.so_ca_da_lam, 0),
        tong_thoi_gian_thang: monthlyTotal.toFixed(2),
        tong_thoi_gian_thang_gio: formatHours(monthlyTotal)
      }
    };

    res.json(result);
  } catch (error) {
    console.error('Lỗi lấy báo cáo tháng:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// API CHECK-IN/OUT THÔNG THƯỜNG (GIỮ NGUYÊN)
// ======================

// Hàm xác định ca làm việc
const getShift = (time) => {
  const hours = time.getHours();
  const minutes = time.getMinutes();
  
  if (hours < 9 || (hours === 9 && minutes < 30)) return 'Ca 1: 7:00 - 9:30';
  if (hours < 12 || (hours === 12 && minutes < 30)) return 'Ca 2: 9:30 - 12:30';
  if (hours < 15) return 'Ca 3: 12:30 - 15:00';
  return 'Ca 4: 15:00 - 17:30';
};

// Check-in thông thường
router.post('/checkin', auth, async (req, res) => {
  const { ma_nhan_vien, ten_nhan_vien } = req.employee;
  const now = new Date();
  const today = new Date().toISOString().split('T')[0];
  const currentTime = now.toTimeString().split(' ')[0];
  const shift = getShift(now);

  const shiftOrder = ['Ca 1: 7:00 - 9:30', 'Ca 2: 9:30 - 12:30', 'Ca 3: 12:30 - 15:00', 'Ca 4: 15:00 - 17:30'];

  try {
    const [empRows] = await db.query(
      'SELECT id FROM nhanvien WHERE ma_nhan_vien = ?',
      [ma_nhan_vien]
    );
    if (empRows.length === 0) {
      return res.status(400).json({ message: 'Nhân viên không tồn tại' });
    }
    const nhan_vien_id = empRows[0].id;

    // Kiểm tra không check-in 2 ca liên tiếp
    const [checkedShifts] = await db.query(
      'SELECT trang_thai FROM cham_cong WHERE ma_nhan_vien = ? AND ngay_cham_cong = ?',
      [ma_nhan_vien, today]
    );

    let isConsecutive = false;
    checkedShifts.forEach(row => {
      const idx = shiftOrder.indexOf(row.trang_thai);
      const currentIdx = shiftOrder.indexOf(shift);
      if (Math.abs(currentIdx - idx) === 1) {
        isConsecutive = true;
      }
    });
    if (isConsecutive) {
      return res.status(400).json({ message: 'Không được check-in 2 ca liên tiếp trong ngày.' });
    }

    // Thêm bản ghi check-in
    await db.query(
      'INSERT INTO cham_cong (nhan_vien_id, ma_nhan_vien, ten_nhan_vien, ngay_cham_cong, gio_vao, trang_thai) VALUES (?, ?, ?, ?, ?, ?)',
      [nhan_vien_id, ma_nhan_vien, ten_nhan_vien, today, currentTime, shift]
    );

    res.json({ message: `Check-in thành công vào ${shift}` });
  } catch (error) {
    console.error('Lỗi check-in:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// Check-out thông thường
router.post('/checkout', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const now = new Date();
  const today = new Date().toISOString().split('T')[0];
  const currentTime = now.toTimeString().split(' ')[0];
  const shift = getShift(now);

  const shiftOrder = ['Ca 1: 7:00 - 9:30', 'Ca 2: 9:30 - 12:30', 'Ca 3: 12:30 - 15:00', 'Ca 4: 15:00 - 17:30'];

  try {
    const [rows] = await db.query(
      'SELECT * FROM cham_cong WHERE ma_nhan_vien = ? AND ngay_cham_cong = ? AND trang_thai = ? AND gio_ra IS NULL',
      [ma_nhan_vien, today, shift]
    );
    if (rows.length === 0) {
      return res.status(400).json({ message: 'Bạn chưa check-in ca này hoặc đã check-out.' });
    }

    // Kiểm tra không check-out 2 ca liên tiếp
    const [checkedShifts] = await db.query(
      'SELECT trang_thai FROM cham_cong WHERE ma_nhan_vien = ? AND ngay_cham_cong = ? AND gio_ra IS NOT NULL',
      [ma_nhan_vien, today]
    );
    
    let isConsecutive = false;
    checkedShifts.forEach(row => {
      const idx = shiftOrder.indexOf(row.trang_thai);
      const currentIdx = shiftOrder.indexOf(shift);
      if (Math.abs(currentIdx - idx) === 1) {
        isConsecutive = true;
      }
    });
    if (isConsecutive) {
      return res.status(400).json({ message: 'Không được check-out 2 ca liên tiếp trong ngày.' });
    }

    const checkInTime = new Date(`${today}T${rows[0].gio_vao}`);
    const checkOutTime = new Date(`${today}T${currentTime}`);
    const workDuration = (checkOutTime - checkInTime) / (1000 * 60 * 60);

    await db.query(
      'UPDATE cham_cong SET gio_ra = ?, thoi_gian_lam = ?, updated_at = NOW() WHERE id = ?',
      [currentTime, workDuration, rows[0].id]
    );

    res.json({ 
      message: `Check-out thành công từ ${shift}`,
      workDuration: workDuration.toFixed(2)
    });
  } catch (error) {
    console.error('Lỗi check-out:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ======================
// CÁC API KHÁC
// ======================

// Lịch sử chấm công cá nhân
router.get('/history', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;

  try {
    const [records] = await db.query(
      'SELECT * FROM cham_cong WHERE ma_nhan_vien = ? ORDER BY ngay_cham_cong DESC, created_at DESC',
      [ma_nhan_vien]
    );
    res.json(records);
  } catch (error) {
    console.error('Lỗi lấy lịch sử:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// Lịch sử chấm công theo tháng/năm
router.get('/history/month', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const { month, year } = req.query;
  try {
    const [records] = await db.query(
      'SELECT * FROM cham_cong WHERE ma_nhan_vien = ? AND MONTH(ngay_cham_cong) = ? AND YEAR(ngay_cham_cong) = ? ORDER BY ngay_cham_cong DESC',
      [ma_nhan_vien, month, year]
    );
    res.json(records);
  } catch (error) {
    console.error('Lỗi lấy lịch sử theo tháng:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// API: Lấy thông tin chi tiết của một ca đăng ký
router.get('/schedule/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query('SELECT * FROM lich_truc WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy ca đăng ký' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Lỗi lấy chi tiết ca:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// API: Hủy đăng ký (nếu chưa check-in)
router.delete('/schedule/:id/cancel', auth, async (req, res) => {
  const { ma_nhan_vien } = req.employee;
  const { id } = req.params;

  try {
    const [rows] = await db.query('SELECT * FROM lich_truc WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy ca đăng ký' });
    
    const record = rows[0];
    
    // Kiểm tra quyền
    if (record.ma_nhan_vien !== ma_nhan_vien) {
      return res.status(403).json({ message: 'Bạn không có quyền hủy ca này' });
    }
    
    // Kiểm tra trạng thái (chỉ được hủy khi chưa check-in)
    if (record.trang_thai !== 'registered') {
      return res.status(400).json({ message: 'Chỉ được hủy khi chưa check-in' });
    }

    await db.query('DELETE FROM lich_truc WHERE id = ?', [id]);

    res.json({ message: 'Hủy đăng ký thành công' });
  } catch (error) {
    console.error('Lỗi hủy đăng ký:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// Hàm chuyển đổi giờ thập phân sang giờ:phút
function formatHours(decimalHours) {
  if (!decimalHours || decimalHours === 0) return "0 giờ 0 phút";
  
  const hours = Math.floor(decimalHours);
  const minutes = Math.round((decimalHours - hours) * 60);
  
  return `${hours} giờ ${minutes} phút`;
}

module.exports = router;