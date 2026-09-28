-- Goslynk Booster - hệ thống tài khoản riêng của app.
-- Import trong phpMyAdmin: chọn database fgankpz_cac -> tab SQL -> dán và chạy.
--
-- Mọi bảng đều có tiền tố gsb_ để không đụng tới bảng của shop (users, booster_*...).
-- Chạy lại file này nhiều lần cũng an toàn (IF NOT EXISTS / INSERT IGNORE).

CREATE TABLE IF NOT EXISTS `gsb_users` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(64) NOT NULL DEFAULT '',
  `role` ENUM('user', 'vip', 'developer', 'admin') NOT NULL DEFAULT 'user',
  `vip_until` DATETIME NULL DEFAULT NULL,
  `is_locked` TINYINT(1) NOT NULL DEFAULT 0,
  `lock_reason` VARCHAR(255) NOT NULL DEFAULT '',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL,
  `last_login_ip` VARCHAR(45) NOT NULL DEFAULT '',
  UNIQUE KEY `uk_gsb_username` (`username`),
  UNIQUE KEY `uk_gsb_email` (`email`),
  KEY `idx_gsb_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Token đăng nhập theo thiết bị. Chỉ lưu SHA-256 của token, không lưu token gốc.
CREATE TABLE IF NOT EXISTS `gsb_sessions` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT UNSIGNED NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `device_name` VARCHAR(100) NOT NULL DEFAULT '',
  `ip` VARCHAR(45) NOT NULL DEFAULT '',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` TIMESTAMP NULL DEFAULT NULL,
  `expires_at` DATETIME NOT NULL,
  UNIQUE KEY `uk_gsb_token_hash` (`token_hash`),
  KEY `idx_gsb_sess_user` (`user_id`),
  CONSTRAINT `fk_gsb_sess_user` FOREIGN KEY (`user_id`) REFERENCES `gsb_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cấu hình chỉnh từ admin panel.
CREATE TABLE IF NOT EXISTS `gsb_settings` (
  `setting_key` VARCHAR(64) PRIMARY KEY,
  `setting_value` TEXT NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- developer_mode = 1: chỉ admin và developer vào được app; user và vip bị chặn cho tới khi tắt.
INSERT IGNORE INTO `gsb_settings` (`setting_key`, `setting_value`) VALUES
('developer_mode', '0'),
('developer_message', 'Ứng dụng đang bảo trì, vui lòng quay lại sau.'),
('registration_open', '1'),
('relay_endpoint', ''),
('relay_psk', '');

-- Chống dò mật khẩu: mỗi lần đăng nhập sai ghi một dòng, API tự dọn dòng cũ.
CREATE TABLE IF NOT EXISTS `gsb_login_attempts` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `ip` VARCHAR(45) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_gsb_attempt_ip_time` (`ip`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lịch sử thao tác trong admin panel.
CREATE TABLE IF NOT EXISTS `gsb_audit_log` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `actor_id` INT UNSIGNED NULL,
  `action` VARCHAR(64) NOT NULL,
  `target` VARCHAR(191) NOT NULL DEFAULT '',
  `detail` VARCHAR(500) NOT NULL DEFAULT '',
  `ip` VARCHAR(45) NOT NULL DEFAULT '',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_gsb_audit_time` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tài khoản admin đầu tiên: đăng ký bình thường trong app, rồi chạy (thay tên đăng nhập):
-- UPDATE `gsb_users` SET `role` = 'admin' WHERE `username` = 'ten_dang_nhap';

-- REDEEM CODES
-- 1. Bảng lưu trữ Danh sách Mã quà tặng (Redeem Codes)
CREATE TABLE IF NOT EXISTS `gsb_redeem_codes` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(64) NOT NULL,                    -- Mã code (VD: GOSLYNK2026, VIP7DAYS)
  `reward_type` ENUM('vip_days', 'role') NOT NULL DEFAULT 'vip_days', -- Loại quà
  `reward_value` INT UNSIGNED NOT NULL DEFAULT 7, -- Giá trị phần thưởng (VD: 7 ngày)
  `max_uses` INT UNSIGNED NOT NULL DEFAULT 0,     -- Số lượt dùng tối đa (0 = không giới hạn)
  `used_count` INT UNSIGNED NOT NULL DEFAULT 0,    -- Số lượt đã sử dụng
  `expires_at` DATETIME NULL DEFAULT NULL,        -- Hạn sử dụng mã (NULL = vĩnh viễn)
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,      -- Trạng thái (1: Bật, 0: Tắt)
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_gsb_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- 2. Bảng lưu vết HWID Ring-0 (Ngăn chặn 1 máy redeem nhiều lần)
CREATE TABLE IF NOT EXISTS `gsb_hwid_redeems` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `code_id` INT UNSIGNED NOT NULL,                 -- Mã code đã sử dụng
  `user_id` INT UNSIGNED NOT NULL,                 -- Tài khoản sử dụng
  `hwid_hash` CHAR(64) NOT NULL,                   -- HWID Ring-0 SHA-256 duy nhất của máy
  `ip` VARCHAR(45) NOT NULL DEFAULT '',            -- IP thực hiện
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- RÀNG BUỘC DUY NHẤT: 1 HWID chỉ được dùng 1 Mã Code đúng 1 lần
  UNIQUE KEY `uk_gsb_hwid_code` (`hwid_hash`, `code_id`),
  KEY `idx_gsb_hwid` (`hwid_hash`),
  CONSTRAINT `fk_gsb_redeem_code` FOREIGN KEY (`code_id`) REFERENCES `gsb_redeem_codes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_gsb_redeem_user` FOREIGN KEY (`user_id`) REFERENCES `gsb_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
----------------------------------------------------------------------------