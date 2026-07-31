// =============================
// 📦 BACKUP SYSTEM - PM2 + CRON VERSION
// =============================

// Buat file terpisah: backup.js
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

// Load config dari .vars.json
const vars = JSON.parse(fs.readFileSync('./.vars.json', 'utf8'));
const BOT_TOKEN = vars.BOT_TOKEN;
const ADMIN_IDS = Array.isArray(vars.USER_ID) ? vars.USER_ID : [vars.USER_ID];

const bot = new Telegraf(BOT_TOKEN);

async function backupDatabase() {
    try {
        console.log('🔄 Starting database backup...');
        
        const dbFiles = [
            { file: path.join(__dirname, 'sellvpn.db'), prefix: 'sellvpn' },
            { file: path.join(__dirname, 'ressel.db'), prefix: 'ressel' }
        ];
        
        // Buat folder backup jika belum ada
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        // Generate filename dengan timestamp
        const now = new Date();
        const timestamp = now.toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .slice(0, 19);
        
        const backupFiles = [];

        for (const entry of dbFiles) {
            if (!fs.existsSync(entry.file)) {
                console.error('❌ Database file not found:', entry.file);
                continue;
            }

            const backupFile = path.join(backupDir, `${entry.prefix}_${timestamp}.db`);
            fs.copyFileSync(entry.file, backupFile);
            const fileSize = (fs.statSync(backupFile).size / 1024 / 1024).toFixed(2); // MB
            console.log(`✅ Backup created: ${backupFile} (${fileSize} MB)`);
            backupFiles.push({ path: backupFile, size: fileSize, prefix: entry.prefix });
        }

        if (backupFiles.length === 0) {
            console.error('❌ Tidak ada database yang berhasil dibackup.');
            return;
        }
        
        // Kirim ke semua admin
        for (const adminId of ADMIN_IDS) {
            for (const backup of backupFiles) {
                try {
                    await bot.telegram.sendDocument(
                        adminId,
                        { source: backup.path },
                        { 
                            caption: `🗄️ *Database Backup*\n\n` +
                                    `📅 ${now.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
                                    `⏰ ${now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
                                    `📄 File: ${backup.prefix}.db\n` +
                                    `📊 Size: ${backup.size} MB\n` +
                                    `✅ Backup otomatis harian`
                        }
                    );
                    console.log(`📤 Sent ${backup.prefix} to admin ${adminId}`);
                } catch (sendError) {
                    console.error(`❌ Failed to send ${backup.prefix} to admin ${adminId}:`, sendError.message);
                }
            }
        }
        
        // Cleanup backup lama (> 7 hari)
        cleanupOldBackups(backupDir);
        
        console.log('🎉 Backup process completed');
        
    } catch (error) {
        console.error('❌ Backup failed:', error);
    } finally {
        // Tutup bot connection
        bot.stop();
    }
}

function cleanupOldBackups(backupDir) {
    try {
        const files = fs.readdirSync(backupDir);
        const now = Date.now();
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        
        files.forEach(file => {
            if ((file.startsWith('sellvpn_') || file.startsWith('ressel_')) && file.endsWith('.db')) {
                const filePath = path.join(backupDir, file);
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtimeMs;
                
                if (fileAge > sevenDays) {
                    fs.unlinkSync(filePath);
                    console.log(`🧹 Deleted old backup: ${file}`);
                }
            }
        });
    } catch (err) {
        console.error('Cleanup error:', err.message);
    }
}

// Jalankan backup
backupDatabase();
