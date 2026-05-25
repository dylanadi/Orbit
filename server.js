const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = 3000;

// Middleware agar Express bisa membaca file JSON dan folder 'public'
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. STATE BUKU BON (Database Simulasi)
// ==========================================
let serverState = {
    balance: 10000.00, // Saldo awal simulasi: $10,000
    positions: [],
    history: []
};

// ==========================================
// 2. ENDPOINT: HALAMAN TRADING & PORTFOLIO
// ==========================================
// Rute ini dipanggil oleh panel kanan (di index.html dan market.html) untuk cek saldo
app.get('/api/portfolio', (req, res) => {
    res.json(serverState);
});

// Endpoint untuk Eksekusi Order (BUY/SELL)
app.post('/api/order', (req, res) => {
    const { side, symbol, price, qty } = req.body;
    const totalCost = price * qty;

    // Validasi saldo
    if (side === 'BUY' && serverState.balance < totalCost) {
        return res.status(400).json({ error: "Saldo tidak cukup bro!" });
    }

    // Potong/tambah saldo
    if (side === 'BUY') {
        serverState.balance -= totalCost;
    } else {
        serverState.balance += totalCost;
    }

    // Catat ke Posisi Terbuka
    const newPos = {
        id: Date.now().toString(),
        symbol,
        side,
        qty,
        entryPrice: price
    };
    serverState.positions.push(newPos);

    // Catat ke Riwayat
    const newHistory = {
        time: new Date().toLocaleTimeString('id-ID'),
        symbol,
        side,
        price,
        qty
    };
    serverState.history.push(newHistory);

    res.json({ success: true, portfolio: serverState });
});

// Endpoint untuk Tutup Posisi (Close Order)
app.post('/api/close', (req, res) => {
    const { id, currentPrice } = req.body;
    const posIndex = serverState.positions.findIndex(p => p.id === id);
    
    if (posIndex === -1) return res.status(404).json({ error: "Posisi tidak ditemukan" });

    const pos = serverState.positions[posIndex];
    const diff = currentPrice - pos.entryPrice;
    const pnl = pos.side === 'BUY' ? (diff * pos.qty) : (-diff * pos.qty);
    
    // Kembalikan modal awal + PnL ke balance
    serverState.balance += (pos.qty * pos.entryPrice) + pnl;
    
    // Hapus posisi
    serverState.positions.splice(posIndex, 1);

    res.json({ success: true, portfolio: serverState });
});

// ==========================================
// 3. ENDPOINT: HALAMAN MARKET (COINGECKO + CACHING)
// ==========================================
let cryptoCache = null;      // Brankas untuk menyimpan data koin
let lastCacheTime = 0;       // Waktu terakhir kali ambil data
const CACHE_TTL = 60 * 1000; // Umur cache: 60.000 ms (60 detik)

app.get('/api/crypto', async (req, res) => {
    const now = Date.now();
    
    // 1. Cek apakah cache masih 'segar' (belum lewat 60 detik)
    if (cryptoCache && (now - lastCacheTime < CACHE_TTL)) {
        console.log("[CACHE] Menyajikan data dari memori lokal (Menghemat kuota API)");
        return res.json(cryptoCache);
    }

    // 2. Jika cache sudah usang, tarik data baru dari CoinGecko
    try {
        console.log("[API] Menarik data segar dari server CoinGecko...");
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: 20, 
                page: 1,
                sparkline: true,
                price_change_percentage: '24h'
            }
        });
        
        // Simpan data baru ke dalam brankas
        cryptoCache = response.data;
        lastCacheTime = now;
        
        res.json(cryptoCache);
    } catch (error) {
        console.error("Gagal mengambil data CoinGecko:", error.message);
        
        // 3. Fallback Darurat: Kalau kena Limit 429, tapi kita punya data lama, tampilkan data lama saja!
        if (cryptoCache) {
            console.log("[CACHE FALLBACK] Kena Limit API! Mengamankan web dengan data lama.");
            return res.json(cryptoCache);
        }
        
        res.status(500).json({ error: 'Gagal mengambil data crypto' });
    }
});

// ==========================================
// 4. JALANKAN SERVER
// ==========================================

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`🚀 Server Backend ORBIT Berhasil Menyala!`);
    console.log(`===========================================`);
    console.log(`• Terminal Trading : http://localhost:${PORT}/index.html`);
    console.log(`• Market Dashboard : http://localhost:${PORT}/market.html`);
    console.log(`===========================================\n`);
});