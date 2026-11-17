CREATE DATABASE IF NOT EXISTS hospital_medical_records;
USE hospital_medical_records;

CREATE TABLE IF NOT EXISTS users (
  wallet_address VARCHAR(42)  NOT NULL PRIMARY KEY,
  full_name      VARCHAR(100) NOT NULL,
  role           ENUM('Doctor','Patient') NOT NULL,
  phone_number   VARCHAR(20)  NOT NULL DEFAULT '',
  age            INT NULL,
  specialization VARCHAR(100) NULL
);

-- Dedicated least-privilege DB user (replaces passwordless root)
CREATE USER IF NOT EXISTS 'medichain_app'@'localhost' IDENTIFIED BY 'PasswordKuat#2026!';
GRANT SELECT, INSERT, UPDATE, DELETE ON hospital_medical_records.* TO 'medichain_app'@'localhost';
FLUSH PRIVILEGES;
