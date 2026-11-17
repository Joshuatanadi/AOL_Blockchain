# MediChain — Fully Hardened Clinical EHR Portal (v3)

## Summary of Security Fixes
1. **VULN-01 (Critical):** Removed hardcoded `ADMIN_KEY`; implemented `HttpOnly` + `SameSite=Strict` PHP session authentication with `session_regenerate_id(true)`.
2. **VULN-02 (High):** Client-side `AES-GCM` encryption (`encryptRecordPayload`) before storing `encryptedPayload` on Ethereum.
3. **VULN-03 (High):** Authenticated `GET` endpoints with role-based PII filtering.
4. **VULN-04 (High):** Doctors authorized to register Patients on-chain and off-chain.
5. **VULN-05 (Medium):** Ownership & RBAC enforcement on `PUT` and `DELETE` endpoints.
6. **VULN-06 (Medium):** Indexed per-user record IDs in `MedicalRecord.sol` to prevent Gas Limit DoS + `mysqli_stmt_affected_rows` validation.
7. **VULN-07 / Finding #9 (Medium/Low):** Self-hosted `vendor/ethers.umd.min.js` & local system font stack (eliminates external CDN SRI dependencies) + strict Content Security Policy (CSP), `Options -Indexes -ExecCGI`, and HTTP security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`).
8. **Finding #3 (Critical Infrastructure):** Added `.htaccess` blocking web access to `.sql`, `.sol`, `.ts`, `.json`, `.md`, `.git`, and `node_modules`.
9. **Finding #5 & #8 (Local XAMPP Environment):**
   - Bind Apache only to loopback (`127.0.0.1:80`) in `C:\xampp\apache\conf\httpd.conf` by changing `Listen 80` to `Listen 127.0.0.1:80` so Apache is unreachable from Public hotspot networks.
   - Update XAMPP to the latest PHP 8.2+/MariaDB 10.11+ release if required by your environment audit.

## Setup Checklist
1. Import `database.sql` in phpMyAdmin / MySQL to create `hospital_medical_records` and the `medichain_app` user.
2. Deploy `contract/MedicalRecord.sol` and update `SMART_CONTRACT_ADDRESS` in `app.js` (or run `npm run deploy`).
3. Update `ADMIN_WALLET` in `api.php` with your deployer wallet address.
4. Ensure `AllowOverride All` is enabled in Apache `httpd.conf` so `.htaccess` protections are active.
