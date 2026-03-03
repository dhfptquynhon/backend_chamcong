const { employee } = require('./auth');

module.exports = (req, res, next) => {
  if (!req.employee.is_admin) {
    return res.status(403).json({ message: 'Không có quyền truy cập' });
  }
  next();
};