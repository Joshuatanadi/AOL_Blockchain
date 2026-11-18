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