# Dokumentasi Endpoint Orkut/OrderKuota

Dokumentasi ini untuk endpoint lokal BotVPN yang menggantikan endpoint RajaServer yang sudah mati. Endpoint ini membuat QRIS dinamis dari `DATA_QRIS` yang tersimpan di `.vars.json`.

Username dan token Orkut/OrderKuota tetap dipakai untuk cek mutasi pembayaran, bukan untuk membuat QRIS.

## Konfigurasi

File konfigurasi: `/root/BotVPN/.vars.json`

Contoh:

```json
{
  "DATA_QRIS": "0002010102112667...",
  "ORKUT_USERNAME": "username_orkut",
  "ORKUT_TOKEN": "token_orkut",
  "LOCAL_PAYMENT_API_KEY": "secret-api-key",
  "ORDERKUOTA_CREATE_MODE": "local",
  "PAYMENT_GATEWAY_MODE": "orderkuota"
}
```

Keterangan:

- `DATA_QRIS`: payload QRIS statis hasil scan, harus dimulai dengan `000201`.
- `ORKUT_USERNAME`: username Orkut untuk cek mutasi pembayaran.
- `ORKUT_TOKEN`: token Orkut untuk cek mutasi pembayaran.
- `LOCAL_PAYMENT_API_KEY`: API key endpoint lokal. Jika kosong, endpoint bisa diakses tanpa key.
- `ORDERKUOTA_CREATE_MODE`: gunakan `local` supaya tidak bergantung provider eksternal.
- `PAYMENT_GATEWAY_MODE`: gunakan `orderkuota` untuk topup otomatis via QRIS Orkut.

## Create Payment

Endpoint utama:

```text
GET /orderkuota/createpayment
```

Alias kompatibel provider:

```text
GET /orderkuota/orderkuota/createpayment
```

### Query Parameters

| Parameter | Wajib | Keterangan |
| --- | --- | --- |
| `apikey` | Kondisional | Wajib jika `LOCAL_PAYMENT_API_KEY` diisi. |
| `amount` | Ya | Nominal QRIS dalam rupiah. Contoh: `2000`. |
| `reference` | Tidak | ID referensi transaksi. Jika kosong, dibuat otomatis. |
| `codeqr` | Tidak | QRIS payload custom. Jika kosong, memakai `DATA_QRIS`. |

### Contoh Request

```bash
curl "http://IP-BOT:6969/orderkuota/createpayment?apikey=secret-api-key&amount=2000&reference=TOPUP-001"
```

Atau pakai alias:

```bash
curl "http://IP-BOT:6969/orderkuota/orderkuota/createpayment?apikey=secret-api-key&amount=2000&reference=TOPUP-001"
```

### Contoh Response Sukses

```json
{
  "status": "success",
  "success": true,
  "result": {
    "reference": "TOPUP-001",
    "amount": 2000,
    "qris_string": "000201010212...",
    "qr_url": "http://IP-BOT:6969/orderkuota/qris-image/TOPUP-001.png",
    "imageqris": {
      "url": "http://IP-BOT:6969/orderkuota/qris-image/TOPUP-001.png"
    },
    "expires_at": 1710000000000
  }
}
```

### Contoh Response Gagal

```json
{
  "status": "error",
  "success": false,
  "message": "DATA_QRIS tidak valid: payload harus dimulai dengan 000201."
}
```

## Ambil Gambar QRIS

Endpoint gambar:

```text
GET /orderkuota/qris-image/:reference.png
```

Contoh:

```bash
curl -o qris.png "http://IP-BOT:6969/orderkuota/qris-image/TOPUP-001.png"
```

Gambar QRIS disimpan sementara di memory bot dan expired otomatis.

## Contoh Kodingan Client Node.js

```js
const axios = require('axios');

async function createQrisPayment() {
  const baseUrl = 'http://IP-BOT:6969';
  const response = await axios.get(`${baseUrl}/orderkuota/createpayment`, {
    params: {
      apikey: 'secret-api-key',
      amount: 2000,
      reference: 'TOPUP-001'
    },
    timeout: 15000
  });

  const body = response.data;
  if (!body.success || !body.result?.imageqris?.url) {
    throw new Error('Create QRIS gagal: ' + JSON.stringify(body));
  }

  return {
    reference: body.result.reference,
    qrisString: body.result.qris_string,
    qrImageUrl: body.result.imageqris.url
  };
}

createQrisPayment()
  .then(console.log)
  .catch(console.error);
```

## Contoh Kodingan Handler Express

Versi ringkas dari handler yang dipakai BotVPN:

```js
app.get('/orderkuota/createpayment', async (req, res) => {
  try {
    const requiredApiKey = process.env.LOCAL_PAYMENT_API_KEY || '';
    const givenApiKey = String(req.query.apikey || '').trim();
    if (requiredApiKey && givenApiKey !== requiredApiKey) {
      return res.status(401).json({
        status: 'error',
        success: false,
        message: 'invalid apikey'
      });
    }

    const amount = Number(req.query.amount);
    const reference = String(req.query.reference || `LOCAL-${Date.now()}`);
    const qrisData = String(req.query.codeqr || process.env.DATA_QRIS || '');

    const qrisString = buildDynamicQrisString(qrisData, amount);
    const qrBuffer = await QRCode.toBuffer(qrisString, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 8
    });

    cache.set(reference, {
      qrBuffer,
      expiresAt: Date.now() + 30 * 60 * 1000
    });

    const imageUrl = `${req.protocol}://${req.get('host')}/orderkuota/qris-image/${reference}.png`;
    return res.json({
      status: 'success',
      success: true,
      result: {
        reference,
        amount,
        qris_string: qrisString,
        qr_url: imageUrl,
        imageqris: { url: imageUrl }
      }
    });
  } catch (error) {
    return res.status(400).json({
      status: 'error',
      success: false,
      message: error.message || 'gagal membuat QRIS'
    });
  }
});
```

Fungsi `buildDynamicQrisString` di BotVPN ada di `app.js`. Fungsi itu melakukan:

- parsing payload QRIS TLV,
- mengubah tag `01` menjadi dinamis `12`,
- menyisipkan tag nominal `54`,
- menghitung ulang CRC tag `63`.

## Cek Mutasi Orkut

File: `api-cekpayment-orkut.js`

Endpoint cek mutasi yang dipakai bot:

```text
POST https://orkutapi.andyyuda41.workers.dev/api/qris-history
```

Body dikirim sebagai `application/x-www-form-urlencoded`:

```text
username=<ORKUT_USERNAME>&token=<ORKUT_TOKEN>&jenis=masuk
```

Contoh Node.js:

```js
const axios = require('axios');
const qs = require('qs');

async function cekMutasiOrkut(username, token) {
  const payload = qs.stringify({
    username,
    token,
    jenis: 'masuk'
  });

  const response = await axios.post(
    'https://orkutapi.andyyuda41.workers.dev/api/qris-history',
    payload,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Encoding': 'gzip',
        'User-Agent': 'okhttp/4.12.0'
      },
      timeout: 15000
    }
  );

  return response.data;
}
```

## Alur Topup BotVPN

1. User input nominal topup.
2. Bot membuat nominal unik dengan admin fee random.
3. Bot memanggil generator QRIS lokal.
4. Bot mengirim gambar QRIS ke user.
5. User bayar sesuai nominal unik.
6. User tekan tombol cek pembayaran.
7. Bot cek mutasi Orkut memakai `ORKUT_USERNAME` dan `ORKUT_TOKEN`.
8. Jika nominal cocok, saldo user ditambahkan.

## Troubleshooting

`DATA_QRIS tidak valid: payload harus dimulai dengan 000201`

Kirim teks hasil scan QRIS, bukan foto, link gambar, atau base64.

`invalid apikey`

`apikey` request tidak sama dengan `LOCAL_PAYMENT_API_KEY`.

`QRIS image expired atau tidak ditemukan`

Request gambar QRIS terlalu lama setelah create payment. Buat ulang payment.

`OrderKuota belum siap: ORKUT_USERNAME/ORKUT_TOKEN`

Isi username dan token Orkut dari menu admin.
