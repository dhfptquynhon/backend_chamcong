# Backend Setup Instructions

## 1. Setup Database

Chạy file SQL để tạo database và tables:

```bash
mysql -u root -p < database.sql
```

Hoặc mở MySQL và chạy trực tiếp file `database.sql`.

## 2. Cấu hình .env

Đảm bảo file `.env` có các biến sau:

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=chamcong
PORT=5000
JWT_SECRET=your_secret_key
```

## 3. Cài đặt dependencies

```bash
npm install
```

## 4. Chạy server

```bash
node server.js
```

Hoặc nếu dùng nodemon:

```bash
nodemon server.js
```

## 5. Kiểm tra server

Sau khi chạy server, bạn sẽ thấy:
- `Server running on port 5000`
- `Connected to MySQL database`
- `Test endpoint: http://localhost:5000/api/test`
- `Auth routes loaded: /api/auth/login, /api/auth/register, /api/auth/forgot-password`

## Troubleshooting

### Lỗi 404 khi gọi API forgot-password

1. **Đảm bảo server đã được restart** sau khi thêm route mới:
   - Dừng server (Ctrl+C)
   - Khởi động lại: `node server.js`

2. **Kiểm tra route đã được đăng ký**:
   - Mở terminal backend
   - Kiểm tra log khi start server, phải thấy: `Auth routes loaded: /api/auth/forgot-password`

3. **Kiểm tra endpoint**:
   - Mở browser hoặc Postman
   - Gọi GET http://localhost:5000/api/test
   - Nếu thấy `{"message": "Server is running"}` thì server đang chạy

4. **Kiểm tra database connection**:
   - Đảm bảo MySQL đang chạy
   - Kiểm tra file `.env` có đúng thông tin kết nối không
   - Kiểm tra database `chamcong` đã được tạo chưa

### Lỗi kết nối database

1. Kiểm tra MySQL service đang chạy
2. Kiểm tra thông tin trong file `.env`
3. Chạy lại file `database.sql` để tạo lại database
