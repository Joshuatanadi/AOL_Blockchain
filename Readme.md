# MediChain – Clinical EHR Platform

Aplikasi rekam medis (Electronic Health Record) berbasis blockchain. Rekam medis disimpan **terenkripsi** di smart contract, sedangkan profil pengguna (nama, telepon, umur, spesialisasi) disimpan di database MySQL. Login memakai **MetaMask**, tanpa password.

## Fitur

| Role | Bisa melakukan |
|------|----------------|
| **Admin** | Mendaftarkan Dokter dan Pasien, mengubah profil, menghapus user, melihat data lengkap semua user |
| **Dokter** | Mendaftarkan Pasien, membuat / mengubah / menghapus (soft delete) rekam medis yang ia buat |
| **Pasien** | Melihat rekam medis aktif miliknya dan daftar dokter, mengubah profil sendiri |

Admin adalah wallet yang men-deploy kontrak (akun Hardhat #0).

## Teknologi

- **Smart contract:** Solidity 0.8.34 + Hardhat 3
- **Frontend:** HTML, CSS, JavaScript murni + [ethers.js](https://docs.ethers.org/v6/) v6 (via CDN)
- **Backend:** PHP + MySQL (XAMPP)
- **Wallet:** MetaMask

## Cara Kerja Singkat

**Pembagian data**

- **On-chain:** role setiap wallet, public key enkripsi, dan rekam medis (hanya ciphertext).
- **Off-chain (MySQL):** profil pengguna. Telepon dan umur hanya terlihat oleh Admin dan pemilik profil.

**Login**

1. Server membuat nonce sekali pakai, wallet menandatanganinya (gratis, bukan transaksi).
2. Signature diverifikasi lewat fungsi `verifyLogin` di smart contract (`eth_call`).
3. Role diambil dari kontrak, bukan dari database. Setiap request, role dicek ulang ke chain.

**Enkripsi rekam medis**

1. Setiap user membuat key pair dari tanda tangan MetaMask (wallet sama = key sama). Private key tidak pernah meninggalkan browser.
2. Setiap record memakai kunci AES-256-GCM acak.
3. Kunci AES dikunci dua kali dengan ECDH: untuk pasien dan untuk dokter pembuat.
4. Hanya pasien dan dokter tersebut yang dapat membuka isi record.

## Struktur Folder

```
├── contract/MedicalRecord.sol   # Smart contract
├── scripts/deploy.ts            # Deploy kontrak + update alamat di app.js
├── hardhat.config.ts            # Konfigurasi Hardhat (sumber: ./contract)
├── api.php                      # Backend: login, sesi, CRUD profil (MySQL)
├── app.js                       # Logika frontend (MetaMask, enkripsi, UI)
├── index.html, style.css        # Tampilan
├── database.sql                 # Skema database
└── .htaccess                    # Security header dan blokir file sensitif
```

## Persiapan

- [Node.js](https://nodejs.org/) (LTS)
- [XAMPP](https://www.apachefriends.org/) (Apache + MySQL)
- Ekstensi browser [MetaMask](https://metamask.io/)

## Instalasi dan Menjalankan

### 1. Taruh proyek di XAMPP

Salin folder proyek ke `C:\xampp\htdocs\` (misalnya `htdocs\AOL_Blockchain`). Lalu buka XAMPP Control Panel dan **Start Apache** dan **MySQL**.

### 2. Import database

Buka `http://localhost/phpmyadmin`, pilih tab **Import**, lalu upload `database.sql`. Ini membuat database `hospital_medical_records` dengan tabel `users`.

### 3. Install dependency

```bash
npm install
```

### 4. Jalankan blockchain lokal (Terminal 1, biarkan tetap berjalan) => jangan lupa di jalaninnya di path file yang kalian simpen

```bash
npm run node
```

### 5. Deploy smart contract (Terminal 2) => ini juga, dan dua duanya jangan di tutup selama mau jalanin kalo di tutup nnt solnya mati

```bash
npm run compile
npm run deploy
```

Script ini mencetak alamat kontrak dan otomatis memperbarui `SMART_CONTRACT_ADDRESS` dan `EXPECTED_CHAIN_ID` di `app.js`.

> **Penting:** alamat kontrak juga ada di `api.php` (konstanta `CONTRACT_ADDRESS`, baris ±18) dan **harus sama** dengan di `app.js`. Deploy pertama pada node baru menghasilkan `0x5fbdb2315678afecb367f032d93f642f64180aa3`, sesuai nilai bawaan. Kalau alamat yang dicetak berbeda, ubah di `api.php` secara manual (atau set environment variable `CONTRACT_ADDRESS`).

### 6. Siapkan MetaMask

1. Import akun Hardhat #0 (Admin) dengan private key:
   `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
2. Network **Hardhat Localhost** akan ditambahkan otomatis oleh aplikasi saat login. Jika manual: RPC `http://127.0.0.1:8545`, Chain ID `31337`, simbol `ETH`.

> ⚠️ Private key di atas adalah akun uji publik bawaan Hardhat. **Jangan pernah dipakai di jaringan sungguhan.**

### 7. Buka aplikasi

`http://localhost/AOL_Blockchain/` (sesuaikan nama folder), lalu klik **Connect Wallet**.

## Alur Pemakaian (Pertama Kali)

1. Login sebagai **Admin** (akun #0).
2. Daftarkan **Dokter** (misalnya akun Hardhat #1, `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`). Konfirmasi transaksi di MetaMask.
3. Ganti akun MetaMask ke dokter lalu login. Akan muncul 2 tanda tangan (login dan kunci enkripsi) dan 1 transaksi untuk menyimpan public key.
4. Dokter mendaftarkan **Pasien** (misalnya akun #2, `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`).
5. **Pasien harus login sekali** agar kunci enkripsinya aktif. Tanpa itu dokter tidak bisa membuat record untuknya.
6. Dokter membuat rekam medis, lalu pasien bisa melihatnya.

## Konfigurasi (Opsional)

`api.php` membaca environment variable berikut (nilai bawaan dalam kurung):

| Variable | Fungsi |
|----------|--------|
| `DB_HOST` (`localhost`) | Host MySQL |
| `DB_USER` (`root`) | User MySQL |
| `DB_PASS` (kosong) | Password MySQL |
| `DB_NAME` (`hospital_medical_records`) | Nama database |
| `RPC_URL` (`http://127.0.0.1:8545`) | Node blockchain |
| `CONTRACT_ADDRESS` | Alamat kontrak |

## Setelah Restart Hardhat Node

Chain Hardhat bersifat sementara: **setiap restart, semua data on-chain hilang**. Lakukan langkah berikut:

1. `npm run deploy` lagi.
2. Kosongkan tabel profil agar sinkron dengan chain:
   ```sql
   TRUNCATE TABLE hospital_medical_records.users;
   ```
3. Hard refresh browser (`Ctrl + F5`).
4. Jika MetaMask menolak transaksi dengan error nonce, buka MetaMask → Settings → Advanced → **Clear activity tab data**.

## Troubleshooting

| Pesan error | Penyebab dan solusi |
|-------------|---------------------|
| `MetaMask not found` | Install atau aktifkan MetaMask. |
| `Cannot reach the blockchain node` | `npm run node` belum berjalan. |
| `No contract found at 0x… on chain ID 31337` | Kontrak belum di-deploy. Jalankan `npm run deploy`, lalu `Ctrl + F5`. |
| `Wallet … is not registered` | Wallet belum didaftarkan Admin/Dokter. |
| `Wrong network` | Pindahkan MetaMask ke chain ID `31337`. |
| `Database unavailable` | MySQL belum jalan atau `database.sql` belum di-import. |
| `Blockchain RPC node unreachable (port 8545)` | PHP tidak bisa menjangkau node. Cek `npm run node` dan `RPC_URL`. |
| `Invalid signature` / `Session no longer valid` | Alamat kontrak di `api.php` berbeda dengan `app.js`, atau role berubah di chain. |
| `This patient has not activated encryption yet` | Minta pasien login sekali. |
| Tombol Delete user gagal terus | User sudah terhapus di chain tapi masih ada di DB. Lihat bagian *Setelah Restart Hardhat Node*. |

## Catatan Keamanan dan Batasan

- Hanya **isi** rekam medis yang terenkripsi. Metadata (alamat pasien, dokter, waktu) tetap bisa dibaca siapa pun di blockchain.
- "Delete" record adalah *soft delete*: data terenkripsi tetap ada di chain, hanya ditandai tidak aktif.
- Semua dokter dapat melihat daftar pasien dan membuat record untuk pasien mana pun (belum ada relasi dokter-pasien atau persetujuan pasien).
- Proyek ini ditujukan untuk jaringan lokal dan pembelajaran, bukan untuk data medis sungguhan.