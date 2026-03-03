const jwt = require('jsonwebtoken');
const db = require('../models/db');

module.exports = async (req, res, next) => {
  try {
    const token = req.header('Authorization').replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [employee] = await db.query(
      'SELECT * FROM nhanvien WHERE ma_nhan_vien = ?',
      [decoded.ma_nhan_vien]
    );

    if (!employee) {
      throw new Error();
    }

    req.employee = employee[0];
    req.token = token;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Vui lòng đăng nhập' });
  }
};