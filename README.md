# BotVPN Standalone

Bot Telegram VPN mandiri. Runtime ini hanya menjalankan `app.js` dan tidak memerlukan bot admin master, database master, tenant ID, atau masa aktif sewa.

Source `hcGenerator.js` dan `darktunnelGenerator.js` tidak disertakan. Fitur generate/unlock HC dan Dark Tunnel berjalan lewat API private:

```text
GENERATOR_API_URL=https://api.zivpn.site/api/config
GENERATOR_API_KEY=API_KEY_USER
```

## Persyaratan

- Node.js 20 atau lebih baru
- Linux untuk fitur PM2, Nginx, backup, dan integrasi shell
- Token bot dari BotFather, ID Telegram admin, dan API key generator

## Menjalankan secara manual

```bash
cp .vars.example.json .vars.json
nano .vars.json
npm ci
npm run build
npm test
npm start
```

Field minimum yang wajib diisi adalah `BOT_TOKEN`, `USER_ID`, dan `GENERATOR_API_KEY`. File `.vars.json` berisi secret dan sudah diabaikan oleh Git.

Pengaturan generator juga bisa diubah dari bot:

```text
Admin Menu -> Tools -> Generator API
```

## Instalasi PM2 di VPS

Cara cepat seperti installer `start`:

```bash
git clone https://github.com/harismy/BotVPNOpenSource.git
cd BotVPNOpenSource
chmod +x start
sudo bash start sellvpn
```

Installer `start` akan clone repo ke `/root/BotVPNOpenSource`, meminta token bot/admin/store/Generator API, membuat `.vars.json`, setup auto-backup cron, install dependency, lalu menjalankan PM2.

Jika repo private, pastikan VPS punya akses clone ke GitHub terlebih dahulu.

Salin folder ini ke VPS, lalu dari dalam folder jalankan:

```bash
chmod +x install.sh
sudo ./install.sh
```

Installer memasang dependency, memvalidasi build standalone, membuat `.vars.json` jika belum ada, lalu menjalankan satu proses bernama `botvpn-standalone`.

```bash
pm2 status botvpn-standalone
pm2 logs botvpn-standalone
pm2 restart botvpn-standalone
```

## Konfigurasi layanan

- Payment gateway, QRIS, grup notifikasi, dan webhook dapat dilengkapi di `.vars.json` atau menu admin.
- PPOB menggunakan akun Digiflazz milik bot ini sendiri. Isi `DIGIFLAZZ_USERNAME`, `DIGIFLAZZ_API_KEY`, dan markup, lalu aktifkan `PPOB_ENABLED`.
- Generate/unlock HC dan Dark Tunnel memakai Generator API utama dengan JSON endpoint `/api/config/hc/generate`, `/api/config/hc/unlock`, `/api/config/dark/generate`, dan `/api/config/dark/unlock`.
- URL boleh diisi sebagai domain saja atau lengkap sampai `/api/config`; bot menormalkannya otomatis. Autentikasi memakai header `Authorization: Bearer <GENERATOR_API_KEY>`.
- Database runtime (`*.db`), log, backup, dan secret tidak disertakan dalam source build baru.

`npm run build` memeriksa sintaks entrypoint dan memastikan file/import khusus bot master serta source generator lokal tidak kembali masuk ke project.
