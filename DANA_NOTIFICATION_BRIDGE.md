# DANA Notification Bridge

Bridge ini membaca notifikasi pembayaran masuk dari aplikasi DANA (`id.dana`) dan
mengirimkannya ke BotVPN. Akun DANA, PIN, OTP, dan sesi login tidak pernah dikirim
ke server.

## Komponen

- Endpoint event: `POST /payment/dana-notification`
- Endpoint heartbeat: `POST /payment/dana-notification/heartbeat`
- Status publik: `GET /payment/dana-notification/health`
- Aplikasi Android: `android/dana-notification-bridge`

Request Android ditandatangani HMAC-SHA256 menggunakan shared secret. Server juga
memvalidasi timestamp, nonce, package `id.dana`, format pesan, nominal, waktu, dan
event ID sebelum mencocokkan pembayaran.

## Konfigurasi Bot

1. Pull source terbaru lalu restart BotVPN.
2. Buka `Admin > Tools > Setting Payment Gateway`.
3. Masuk ke `Setting DANA Notifikasi`.
4. Tekan `Buat/Reset Shared Secret` dan masukkan nilainya di aplikasi Android.
5. Masukkan string QRIS milik DANA Bisnis melalui `Set QRIS DANA Bisnis`.
6. Pilih `Mode: DANA Notifikasi`.
7. Domain HTTPS yang sudah dipakai webhook multi-login dapat langsung dipakai.
   Konfigurasi Nginx BotVPN meneruskan seluruh path ke port bot.

Jangan memasukkan shared secret ke Git, chat publik, atau screenshot.

## Build APK

Windows:

```powershell
cd android\dana-notification-bridge
.\gradlew.bat assembleDebug
```

Linux/macOS:

```bash
cd android/dana-notification-bridge
./gradlew assembleDebug
```

APK debug berada di:

```text
android/dana-notification-bridge/app/build/outputs/apk/debug/app-debug.apk
```

## Konfigurasi Android

1. Pasang APK pada HP yang memiliki DANA Bisnis.
2. Isi URL dasar yang ditampilkan menu DANA. URL ini memakai domain webhook
   multi-login yang sama, contoh `https://bot.example.com`.
3. Isi shared secret dari menu admin bot lalu simpan.
4. Tekan `Buka Akses Notifikasi` dan aktifkan `DANA Payment Listener`.
5. Tekan `Izinkan Berjalan di Latar Belakang` dan izinkan pengecualian baterai.
6. Pada HP TECNO/HiOS, aktifkan juga `Auto-start` untuk DANA Bridge melalui
   pengaturan Phone Master/Battery Lab jika opsi tersebut tersedia.
7. Tekan `Tes Koneksi` lalu periksa status `Online`.
8. Gunakan Wi-Fi dengan data seluler sebagai koneksi cadangan.

Saat listener aktif, Android menampilkan notifikasi permanen `DANA Bridge aktif`.
Notifikasi ini diperlukan agar sistem tidak menghentikan listener ketika aplikasi
ditutup atau layar dimatikan. Menekan `Paksa berhenti` tetap akan mematikan listener
sampai aplikasi dibuka kembali; cukup keluarkan aplikasi dari recent apps.

Selain callback notifikasi realtime, bridge memindai notifikasi DANA aktif setiap
tiga detik sebagai fallback untuk perangkat yang menunda callback saat aplikasi
berada di background. Event yang sudah diproses disimpan lokal selama tujuh hari
untuk mencegah pengiriman ulang.

Listener memegang partial wake lock selama aktif agar loop tetap berjalan ketika
layar mati. Pada TECNO/HiOS, buka `Buka Pengaturan Background TECNO`, pilih DANA
Bridge, lalu izinkan aktivitas background/tanpa pembatasan jika pilihannya tersedia.

Bot hanya menganggap bridge online jika heartbeat terakhir diterima maksimal tiga
menit lalu. Ketika HP offline, top-up DANA otomatis ditutup agar transaksi baru
tidak dibuat tanpa sistem verifikasi.

## Format Notifikasi

Parser saat ini menerima pola resmi yang terdeteksi pada perangkat:

```text
Judul: Pembayaran Masuk
Pesan: Rp200 dari Gopay berhasil diterima DANA Bisnis.
Package: id.dana
```

Notifikasi tidak berisi nomor referensi pembayaran. Karena itu bot hanya menerima
nominal yang cocok tepat dengan satu transaksi pending. DANA tidak memakai biaya
atau kode unik: transfer Rp1.000 akan menambah saldo Rp1.000. Untuk mencegah salah
pencocokan, satu nominal DANA hanya boleh dipakai oleh satu transaksi pending pada
saat yang sama. Event disimpan di SQLite agar notifikasi duplikat tidak mengisi
saldo dua kali.

## Pemeriksaan

```bash
curl https://bot.example.com/payment/dana-notification/health
```

Respons sehat setelah aplikasi terhubung:

```json
{"ok":true,"configured":true,"online":true,"queue_size":0}
```
