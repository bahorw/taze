# Chess Assist — v2.2

chess.com ve lichess üzerinde çalışan motor destekli overlay. En iyi hamle okla, değerlendirme cam panelde.

Motor: **Stockfish 17.1 Lite (NNUE + SIMD)**, yerel çalışır. NNUE + anında ok akışı; d18 ≈ 2 sn, d24 ≈ 8 sn.

## Yeni Özellikler

- **Varyantlar (Multi PV):** Araç çubuğundan anahtarını aç/kapat; kaç varyant görüneceğini (2–5) ayarlayabilirsiniz. Her varyant için renk gradyanı: en iyi hamle parlak yeşil, kayanlar yeşilden kızılara doğru gradyan (içerideki derece/puan göre). HUD ve popup'da renkli tablo listesi gösterilir.
- **Oto Oynama (Auto Play):** Anahtar tuşu ve oturum verisi. Sadece oyuncu sırasındaysa, arama tamamlandıktan ve en iyi hamle belirledikten sonra, fare/pointer olayları ile hamleyi yapar. Promotion da desteklenir. Ayarlar kaydedilir, bir sonraki açılımda hatırlanır. HUD üzerinden aktif/pasif ayarlanabilir.
- **Derinlik ayarlaması:** 6–24 aralığı. Motor artık çok daha hızlı: 18 varsayılan, 20–22 analiz için ideal.
- **Birinci hamle anında görünür:** Motor aramaya başladığında `info ... pv` satırlarından ok çıkıyor, 0.15–0.4 sn içinde.

## Kullanım

- **ENGINE anahtarı:** overlay'i açar/kapatır.
- **SEARCH DEPTH:** 6–24 arası. Hızlı oyun için 12–14, analiz için 18+ önerilir.
- **Multi PV toggle:** ENGINE açıkken popup'tan varianta aç/kapat; count ayarlayıcısıyla 2–5 arasında değişir.
- **Variant rows:** Popup ve HUD'da renkli oklar ve puan/derinlik bilgisi gösterilir.
- **Auto Play toggle:** Açık olduğunda, pozisyon değişince ve sizin sıranız olduğunda motor hamleyi oynar.
- Tahta üstündeki cam HUD: en iyi hamle, değerlendirme, derinlik ve motor durumu.
- Tahtanın üzerinde animasyonlu ok en iyi hamleyi gösterir. Varyantlar renkli oklarla gösterilir: en iyi yeşil, kaysanlar daha koyu yeşilden kırmızılara doğru.
- Popup'taki durum kartı canlı olarak motorun sonucunu gösterir.

## Ne düzeltildi

- `manifest.json` v2.2.0; `web_accessible_resources` genişletildi.
- `content.js`de `MultiPV` destekleniyor; `info ... pv` satırları işleniyor.
- `onEngineMessage` `multipv` raporları için; `pv` satırları per rank ayrıştırılıyor.
- Renk gradyanı: rank 1 → 145° (hava yeşili); rank N → 145° × (1 - (N-1)/(total-1)) gradyan.
- `popup.html` ve `popup.js`de variant listesi, count stepper ve auto switch; `popup.css`de renk stilleri ve tablo satırları.
- `README.md` güncellendi: sürüm 2.2, Stockfish 17.1 info, otoplay notları.

## Kurulum (Brave)

1. `brave://extensions` adresini aç.
2. Sağ üstten **Developer mode / Geliştirici modu**nu aç.
3. **Load unpacked / Paketlenmemiş yükle** butonuna bas.
4. `C:\Users\can\Desktop\Yeni klasör (3)` klasörünü seç.
5. Eklenti yüklendikten sonra bir chess.com veya lichess sekmesi aç (yüklüyse sayfayı yenile).
6. Araç çubuğundaki at ikonuna tıkla, **ENGINE** anahtarını aç.
7. Popup'tan **Multi PV** anahtarını aç/kapat, count ayarlayın.
8. **Auto Play** togglesini açın; sadece sizin sıranızda ve arama bittiğinde hareket eder.

## Bilinmeyen

- Motor ilk açılışta 7 MB'lık NNUE dosyasını yüklediği için 1–2 sn'lik bir ısınma olur; sonraki aramalar hızlıdır.
- Tarayıcı eklentisi tek iş parçacığıyla çalıştığı için çoklu çekirdek kullanılamıyor, ama NNUE + anında ok akışı bunu fazlasıyla telafi ediyor.
- Auto play sadece oyuncu sırasındaydığında ve motor araması bittiğinde çalışır; provisional/hızlı hamleler oynanmaz.
- Varyant sayısı (2–5) popup'tan ve HUD'dan ayrı ayrı kontrol edilebilir.