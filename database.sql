-- Giữ nguyên cấu trúc database như bạn đã cung cấp
-- Xóa database nếu tồn tại
DROP DATABASE IF EXISTS chamcong;
CREATE DATABASE chamcong CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chamcong;

-- ======================
-- 1. Bảng nhân viên
-- ======================
CREATE TABLE nhanvien (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ma_nhan_vien VARCHAR(50) NOT NULL UNIQUE,
    ten_nhan_vien VARCHAR(100) NOT NULL,
    password VARCHAR(255) NOT NULL,
    is_admin TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ======================
-- 2. Bảng chấm công THÔNG THƯỜNG
-- ======================
CREATE TABLE cham_cong (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nhan_vien_id INT NOT NULL,
    ma_nhan_vien VARCHAR(50) NOT NULL, -- THÊM TRƯỜNG NÀY
    ten_nhan_vien VARCHAR(100) NOT NULL, -- THÊM TRƯỜNG NÀY
    ngay_cham_cong DATE NOT NULL,
    gio_vao TIME,
    gio_ra TIME,
    trang_thai VARCHAR(50), -- Lưu ca làm việc: "Ca 1: 7:00 - 9:30", v.v.
    thoi_gian_lam FLOAT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_chamcong_nhanvien
        FOREIGN KEY (nhan_vien_id) REFERENCES nhanvien(id)
        ON DELETE CASCADE,

    INDEX idx_ngay_cham_cong (ngay_cham_cong),
    INDEX idx_nhan_vien_id (nhan_vien_id),
    INDEX idx_ma_nhan_vien (ma_nhan_vien)
) ENGINE=InnoDB;

-- ======================
-- 3. Bảng trực thay
-- ======================
CREATE TABLE truc_thay (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nguoi_nho_id INT NOT NULL,
    nguoi_duoc_nho_id INT NOT NULL,
    ca VARCHAR(50),
    ngay DATE,
    trang_thai VARCHAR(20) DEFAULT 'cho',
    admin_duyet TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_tructhay_nguoinho
        FOREIGN KEY (nguoi_nho_id) REFERENCES nhanvien(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_tructhay_nguoiduocnho
        FOREIGN KEY (nguoi_duoc_nho_id) REFERENCES nhanvien(id)
        ON DELETE CASCADE,

    INDEX idx_ngay (ngay),
    INDEX idx_ca (ca)
) ENGINE=InnoDB;

-- ======================
-- 4. Bảng lịch trực (CHO PHÉP NHIỀU NGƯỜI)
-- ======================
CREATE TABLE lich_truc (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ngay DATE NOT NULL,
    ca VARCHAR(10) NOT NULL,
    nhan_vien_id INT NOT NULL,
    ma_nhan_vien VARCHAR(50) NOT NULL,
    ten_nhan_vien VARCHAR(255) NOT NULL,
    trang_thai ENUM('registered','checked_in','checked_out') DEFAULT 'registered',
    gio_vao TIME NULL,
    gio_ra TIME NULL,
    thoi_gian_lam DECIMAL(5,2) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_lich_truc_nhanvien
        FOREIGN KEY (nhan_vien_id) REFERENCES nhanvien(id)
        ON DELETE CASCADE,

    INDEX idx_ngay_ca (ngay, ca),
    INDEX idx_nhan_vien_id (nhan_vien_id),
    INDEX idx_ngay_ca_nhan_vien (ngay, ca, nhan_vien_id)
) ENGINE=InnoDB;

-- ======================
-- 5. Trigger giới hạn số lượng (tối đa 6 người/ca)
-- ======================
DELIMITER $$

CREATE TRIGGER before_insert_lich_truc
BEFORE INSERT ON lich_truc
FOR EACH ROW
BEGIN
    DECLARE user_count INT;
    
    SELECT COUNT(*) INTO user_count 
    FROM lich_truc 
    WHERE ngay = NEW.ngay AND ca = NEW.ca;
    
    IF user_count >= 6 THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Ca đã đủ số lượng người đăng ký (tối đa 6 người)';
    END IF;
END$$

DELIMITER ;

-- ======================
-- 6. Thêm dữ liệu mẫu
-- ======================
-- Thêm admin
INSERT INTO nhanvien (ma_nhan_vien, ten_nhan_vien, password, is_admin) 
VALUES ('admin001', 'Nguyễn Văn Admin', '$2a$10$r4J5h6t7u8i9o0p1q2w3e4r5t6y7u8i9o0p1q2w3e4r5t6y7u8i9o0p', 1);

-- Thêm nhân viên
INSERT INTO nhanvien (ma_nhan_vien, ten_nhan_vien, password) 
VALUES 
('1', 'Tuân', '$2a$10$r4J5h6t7u8i9o0p1q2w3e4r5t6y7u8i9o0p1q2w3e4r5t6y7u8i9o0p'),
('2', 'Vương', '$2a$10$r4J5h6t7u8i9o0p1q2w3e4r5t6y7u8i9o0p1q2w3e4r5t6y7u8i9o0p');

-- ======================
-- 7. Kiểm tra
-- ======================
DESCRIBE nhanvien;
DESCRIBE cham_cong;
DESCRIBE truc_thay;
DESCRIBE lich_truc;

SELECT * FROM nhanvien;
