const fs = require('fs');
const path = require('path');

// Yollar
const packageJsonPath = path.join(__dirname, 'package.json');
const targetDir = path.join(__dirname, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const latestJsonPath = path.join(__dirname, 'latest.json');

try {
  // 1. package.json'dan versiyonu oku
  const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = packageData.version;

  // 2. İmza dosyasını bul (v1.2.0 gibi dinamik isimde olacağı için dosyaları tarıyoruz)
  const files = fs.readdirSync(targetDir);
  const sigFile = files.find(f => f.endsWith('.exe.sig'));
  const exeFile = files.find(f => f.endsWith('.exe'));

  if (!sigFile || !exeFile) {
    console.error("HATA: .exe veya .sig dosyası bulunamadı. Lütfen önce 'npm run tauri build' komutunu çalıştırın.");
    process.exit(1);
  }

  // 3. İmzayı oku
  const signature = fs.readFileSync(path.join(targetDir, sigFile), 'utf8');

  // 4. Exe adındaki boşlukları vs URL uyumlu hale getir
  const encodedExeName = encodeURIComponent(exeFile);

  // 5. latest.json içeriğini oluştur
  const latestJson = {
    version: version,
    notes: "Uygulama arka plan senkronizasyonu ve performans güncellemeleri yapıldı.",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: signature,
        // GitHub release URL formatı (Bunu istersen Vercel veya başka bir yere göre değiştirebilirsin)
        url: `https://github.com/FURSOY/mail-releases/releases/download/v${version}/${encodedExeName}`
      }
    }
  };

  // 6. Dosyaya yaz
  fs.writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2));
  console.log(`✅ latest.json başarıyla oluşturuldu! (Versiyon: v${version})`);
  console.log(`   Dosya yolu: ${latestJsonPath}`);

} catch (error) {
  console.error("Beklenmeyen bir hata oluştu:", error);
}