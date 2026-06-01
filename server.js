// server.js
// ==========================================
// ORBIT - Full Backend Server (Express + Web3 + Midtrans)
// ==========================================

require('dotenv').config(); // ✅ Load .env variables - WAJIB DI BARIS 1

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURATION
// ==========================================

// Midtrans Config
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY;
const MIDTRANS_IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const MIDTRANS_API_URL = MIDTRANS_IS_PRODUCTION 
    ? 'https://api.midtrans.com' 
    : 'https://api.sandbox.midtrans.com';

// Blockchain Config - Updated ABI untuk OrbitDEX v2 (Portfolio Support)
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xfFE1F8afC7E780d37F4C3dF7B67cDd5DB66af160";
const CONTRACT_ABI = [
    // Deposit & Balance (Cash)
    "function deposit(address _user, uint256 _amount, string _method, string _txRef) public",
    "function getBalance(address _user) public view returns (uint256)",
    
    // Asset Trading (Portfolio)
    "function buyAsset(string _symbol, uint256 _price, uint256 _qty) public",
    "function sellAsset(string _symbol, uint256 _price, uint256 _qty) public",
    
    // Portfolio Views
    "function getUserPortfolio(address _user) public view returns (tuple(string symbol, uint256 quantity, uint256 avgBuyPrice, uint256 lastUpdated)[])",
    "function getAssetHolding(address _user, string _symbol) public view returns (tuple(string symbol, uint256 quantity, uint256 avgBuyPrice, uint256 lastUpdated))",
    
    // History & Deposits
    "function getTrades(address _user) public view returns (tuple(string symbol, string side, uint256 price, uint256 qty, uint256 timestamp)[])",
    "function getUserDeposits(address _user) public view returns (tuple(address user, uint256 amount, string method, uint256 timestamp, string txRef)[])"
];

// Web3 Provider & Wallet
const provider = new ethers.providers.JsonRpcProvider(process.env.INFURA_RPC_URL);
const wallet = new ethers.Wallet(process.env.BACKEND_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

// In-memory state (simulasi database untuk trading mockups)
let serverState = {
    balance: 10000.00,
    positions: [],
    history: []
};

// ==========================================
// IDEMPOTENCY CACHE (DEFINISI SEBELUM DIGUNAKAN!)
// ==========================================
const processedOrders = new Map(); // Simpan { orderId: timestamp }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 jam

// ✅ Helper: Cek apakah order sudah diproses FINAL (hanya cache success/cancelled, BUKAN pending)
function isOrderProcessed(orderId) {
    const now = Date.now();
    const processed = processedOrders.get(orderId);
    
    // Jika sudah diproses (final) dan belum expired
    if (processed && (now - processed < CACHE_TTL)) {
        return true;
    }
    
    // Jika expired atau belum ada, return false (biar caller bisa proses)
    return false;
}

// ✅ Helper: Tandai order sebagai sudah diproses (HANYA panggil setelah deposit sukses atau cancelled)
function markOrderProcessed(orderId) {
    processedOrders.set(orderId, Date.now());
    console.log(`🔒 Order ${orderId} marked as processed (final)`);
}

// Cleanup expired entries every hour (auto maintenance)
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of processedOrders) {
        if (now - value > CACHE_TTL) {
            processedOrders.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} expired order entries`);
}, 60 * 60 * 1000);

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ==========================================
// API: PORTFOLIO & TRADING (Simulasi Mockup)
// ==========================================

app.get('/api/portfolio', (req, res) => {
    res.json(serverState);
});

app.post('/api/order', (req, res) => {
    const { side, symbol, price, qty } = req.body;
    const totalCost = price * qty;

    if (side === 'BUY' && serverState.balance < totalCost) {
        return res.status(400).json({ error: "Saldo tidak cukup bro!" });
    }

    if (side === 'BUY') {
        serverState.balance -= totalCost;
    } else {
        serverState.balance += totalCost;
    }

    const newPos = {
        id: Date.now().toString(),
        symbol,
        side,
        qty,
        entryPrice: price
    };
    serverState.positions.push(newPos);

    serverState.history.push({
        time: new Date().toLocaleTimeString('id-ID'),
        symbol,
        side,
        price,
        qty
    });

    res.json({ success: true, portfolio: serverState });
});

app.post('/api/close', (req, res) => {
    const { id, currentPrice } = req.body;
    const posIndex = serverState.positions.findIndex(p => p.id === id);
    
    if (posIndex === -1) return res.status(404).json({ error: "Posisi tidak ditemukan" });

    const pos = serverState.positions[posIndex];
    const diff = currentPrice - pos.entryPrice;
    const pnl = pos.side === 'BUY' ? (diff * pos.qty) : (-diff * pos.qty);
    
    serverState.balance += (pos.qty * pos.entryPrice) + pnl;
    serverState.positions.splice(posIndex, 1);

    res.json({ success: true, portfolio: serverState });
});

// ==========================================
// ✅ API: COINGECKO + CACHING (FIXED & ROBUST)
// ==========================================
let cryptoCache = null;
let lastCacheTime = 0;
const CRYPTO_CACHE_TTL = 60 * 1000; // 60 detik cache
const API_TIMEOUT = 10000; // 10 detik timeout

app.get('/api/crypto', async (req, res) => {
    try {
        const now = Date.now();
        
        // ✅ Return cache jika masih valid (kurangi load API)
        if (cryptoCache && (now - lastCryptoCacheTime < CRYPTO_CACHE_TTL)) {
            console.log('📦 Returning cached crypto data');
            return res.json(cryptoCache);
        }
        
        console.log('🔄 Fetching fresh data from CoinGecko...');
        
        // ✅ Fetch dengan timeout & retry logic
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: 20,
                page: 1,
                sparkline: true,
                price_change_percentage: '24h'
            },
            timeout: API_TIMEOUT,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'OrbitDEX/1.0' // Good practice untuk API calls
            }
        });
        
        // ✅ Update cache
        cryptoCache = response.data;
        lastCryptoCacheTime = now;
        
        console.log(`✅ Fetched ${response.data.length} coins from CoinGecko`);
        res.json(cryptoCache);
        
    } catch (error) {
        console.error('❌ CoinGecko API error:', {
            message: error.message,
            code: error.code,
            status: error.response?.status
        });
        
        // ✅ Fallback: Return cache lama jika ada (graceful degradation)
        if (cryptoCache) {
            console.log('⚠️ Returning stale cache due to API error');
            return res.json(cryptoCache);
        }
        
        // ✅ Error response dengan detail
        res.status(500).json({ 
            error: 'Gagal mengambil data crypto',
            details: error.message,
            hint: 'Coba refresh atau periksa koneksi internet'
        });
    }
});

// ==========================================
// API: WALLET & MIDTRANS
// ==========================================

// 1. Create Payment Transaction (Snap API - Modal/Popup Mode)
app.post('/api/wallet/create-payment', async (req, res) => {
    try {
        const { amount, paymentMethod, userAddress } = req.body;
        
        console.log('💳 Create Payment Request:', { amount, paymentMethod, userAddress });
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }
        if (!userAddress) {
            return res.status(400).json({ error: 'userAddress is required' });
        }
        
        // Validasi API Key
        if (!MIDTRANS_SERVER_KEY || !MIDTRANS_SERVER_KEY.startsWith('SB-Mid-server-')) {
            console.error('❌ MIDTRANS_SERVER_KEY not configured or invalid!');
            return res.status(500).json({ 
                error: 'Midtrans not configured',
                hint: 'Set valid SB-Mid-server-... key in .env'
            });
        }
        
        const orderId = `DEPOSIT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const grossAmount = Math.floor(parseFloat(amount)); // Midtrans butuh integer
        
        console.log(`🔗 Calling Midtrans Snap API: ${orderId} - ${grossAmount}`);
        
        // ✅ PAYLOAD UNTUK SNAP API (Modal Mode)
        const paymentPayload = {
            transaction_details: {
                order_id: orderId,
                gross_amount: grossAmount
            },
            customer_details: {
                first_name: "User",
                email: "user@example.com",
                phone: "+6281234567890"
            },
            enabled_payments: [paymentMethod || 'bank_transfer', 'credit_card', 'gopay', 'shopeepay', 'qris'],
            custom_field1: userAddress,
            callbacks: {
                finish: `http://localhost:${PORT}/wallet/success?orderId=${orderId}&userAddress=${userAddress}`,
                error: `http://localhost:${PORT}/wallet/error?orderId=${orderId}&userAddress=${userAddress}`,
                pending: `http://localhost:${PORT}/wallet/pending?orderId=${orderId}&userAddress=${userAddress}`
            }
        };

        const response = await axios.post(
            `${MIDTRANS_API_URL}/snap/v1/transactions`,
            paymentPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64')
                },
                timeout: 10000
            }
        );

        console.log('✅ Midtrans Snap Response:', {
            token: response.data.token ? '***' : null,
            redirect_url: response.data.redirect_url ? '***' : null
        });

        // ✅ RETURN TOKEN (untuk frontend snap.pay())
        res.json({
            success: true,
            token: response.data.token,
            orderId: orderId,
            redirectUrl: response.data.redirect_url
        });

    } catch (error) {
        console.error('❌ Midtrans Snap ERROR:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status,
            config: {
                url: error.config?.url,
                method: error.config?.method
            }
        });
        
        res.status(500).json({ 
            error: 'Failed to create payment',
            details: error.response?.data?.status_message || error.message,
            validation: error.response?.data?.validation_messages,
            status: error.response?.status
        });
    }
});

// 2. Midtrans Notification Handler (Webhook - Server-to-Server)
app.post('/api/wallet/midtrans-notification', async (req, res) => {
    try {
        console.log('📩 Webhook Headers:', req.headers['content-type']);
        console.log('📩 Webhook Body Type:', typeof req.body);
        
        if (!req.body || Object.keys(req.body).length === 0) {
            console.error('❌ req.body kosong!');
            return res.status(400).json({ error: 'Invalid payload. Send JSON body.' });
        }

        const notification = req.body;
        const orderId = notification.order_id;
        const transactionStatus = notification.transaction_status;
        const fraudStatus = notification.fraud_status;
        const grossAmount = parseFloat(notification.gross_amount);
        const userAddress = notification.custom_field1;
        
        console.log(`🔍 Processing: ${orderId} - ${transactionStatus} for ${userAddress || 'UNKNOWN'}`);

        // ✅ IDEMPOTENCY CHECK: Skip HANYA jika sudah FINAL (success/cancelled)
        if (isOrderProcessed(orderId)) {
            console.log(`⚠️ Order ${orderId} already processed (final), skipping duplicate webhook`);
            return res.status(200).json({ success: true, message: 'Already processed' });
        }

        let depositStatus = 'pending';
        
        if ((transactionStatus === 'capture' || transactionStatus === 'settlement') && fraudStatus === 'accept') {
            depositStatus = 'success';
            console.log('✅ Payment verified, calling contract.deposit()...');
            
            try {
                // Validasi userAddress
                if (!userAddress || !ethers.utils.isAddress(userAddress)) {
                    throw new Error(`Invalid userAddress: ${userAddress}`);
                }
                
                const amountInUnits = Math.floor(grossAmount * 10000);
                console.log(`💰 Depositing ${amountInUnits} units for ${userAddress}`);
                
                const tx = await contract.deposit(userAddress, amountInUnits, notification.payment_type, orderId);
                await tx.wait();
                
                console.log(`✅ Deposit recorded on-chain: ${tx.hash}`);
                
                // ✅ Tandai order sebagai processed HANYA SETELAH deposit blockchain sukses
                markOrderProcessed(orderId);
                
            } catch (blockchainErr) {
                console.error('❌ Blockchain deposit failed:', blockchainErr.message);
                depositStatus = 'failed';
            }
        } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
            depositStatus = 'cancelled';
            markOrderProcessed(orderId);
        }

        console.log(`🏁 Webhook processed. Status: ${depositStatus}`);
        res.status(200).json({ success: true, status: depositStatus });

    } catch (error) {
        console.error('❌ Notification handler error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// 3. Get User Balance from Blockchain (Cash Balance)
app.get('/api/wallet/balance/:userAddress', async (req, res) => {
    try {
        const { userAddress } = req.params;
        
        if (!ethers.utils.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid address' });
        }
        
        const balanceUnits = await contract.getBalance(userAddress);
        
        // ✅ Convert dari units (4 desimal) ke IDR sebagai NUMBER
        const balanceIDR = parseFloat(ethers.utils.formatUnits(balanceUnits, 4));
        
        res.json({
            success: true,
            balanceIDR: balanceIDR,
            balanceUnits: balanceUnits.toString()
        });
        
    } catch (error) {
        console.error('❌ Get balance error:', error);
        res.status(500).json({ error: 'Failed to get balance' });
    }
});

// 4. Get User Deposit History from Blockchain
app.get('/api/wallet/deposits/:userAddress', async (req, res) => {
    try {
        const { userAddress } = req.params;
        
        if (!ethers.utils.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid address' });
        }
        
        const deposits = await contract.getUserDeposits(userAddress);
        
        const formattedDeposits = deposits.map(d => ({
            user: d.user,
            amount: parseFloat(ethers.utils.formatUnits(d.amount, 4)),
            method: d.method,
            timestamp: new Date(d.timestamp.toNumber() * 1000).toISOString(),
            txRef: d.txRef,
            status: 'success'
        })).reverse();
        
        res.json({
            success: true,
            deposits: formattedDeposits
        });
        
    } catch (error) {
        console.error('❌ Get deposits error:', error);
        res.status(500).json({ error: 'Failed to get deposits' });
    }
});

// ==========================================
// ✅ NEW: PORTFOLIO ENDPOINTS (Crypto Assets)
// ==========================================

// 5. Get User Portfolio (Crypto Assets Only)
app.get('/api/portfolio/assets/:userAddress', async (req, res) => {
    try {
        const { userAddress } = req.params;
        
        if (!ethers.utils.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid address' });
        }
        
        // Get asset holdings from contract
        const holdings = await contract.getUserPortfolio(userAddress);
        
        // Format holdings with current prices (fetch from CoinGecko)
        const symbols = holdings.map(h => h.symbol.toLowerCase());
        let currentPrices = {};
        
        try {
            // Fetch current prices for all symbols
            const priceRes = await axios.get(
                `https://api.coingecko.com/api/v3/simple/price?ids=${symbols.join(',')}&vs_currencies=usd`,
                { timeout: 8000 }
            );
            currentPrices = priceRes.data;
        } catch (e) {
            console.warn('Failed to fetch current prices, using fallback');
        }
        
        // Format response with P&L calculation
        const IDR_RATE = 15000; // 1 USD = 15.000 IDR
        
        const portfolio = holdings
            .filter(h => h.quantity.gt(0)) // Only show assets with quantity > 0
            .map(h => {
                const symbol = h.symbol.toUpperCase();
                const quantity = parseFloat(ethers.utils.formatUnits(h.quantity, 4));
                const avgBuyPriceUSD = parseFloat(ethers.utils.formatUnits(h.avgBuyPrice, 4));
                
                // Get current price (fallback to avg buy price if API fails)
                const coinGeckoId = symbol === 'BTC' ? 'bitcoin' : 
                                   symbol === 'ETH' ? 'ethereum' : 
                                   symbol === 'USDT' ? 'tether' : symbol.toLowerCase();
                const currentPriceUSD = currentPrices[coinGeckoId]?.usd || avgBuyPriceUSD;
                
                // Calculate values in IDR
                const avgBuyPriceIDR = avgBuyPriceUSD * IDR_RATE;
                const currentPriceIDR = currentPriceUSD * IDR_RATE;
                const totalValueIDR = quantity * currentPriceIDR;
                const totalCostIDR = quantity * avgBuyPriceIDR;
                const pnlIDR = totalValueIDR - totalCostIDR;
                const pnlPercent = totalCostIDR > 0 ? (pnlIDR / totalCostIDR) * 100 : 0;
                
                return {
                    symbol,
                    quantity: quantity.toFixed(6),
                    avgBuyPrice: avgBuyPriceIDR.toFixed(0),
                    currentPrice: currentPriceIDR.toFixed(0),
                    totalValue: totalValueIDR.toFixed(0),
                    pnl: pnlIDR.toFixed(0),
                    pnlPercent: pnlPercent.toFixed(2),
                    isProfit: pnlIDR >= 0,
                    lastUpdated: new Date(h.lastUpdated.toNumber() * 1000).toISOString()
                };
            });
        
        // Calculate portfolio totals
        const totalValue = portfolio.reduce((sum, a) => sum + parseFloat(a.totalValue), 0);
        const totalPnl = portfolio.reduce((sum, a) => sum + parseFloat(a.pnl), 0);
        const totalCost = totalValue - totalPnl;
        const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
        
        res.json({
            success: true,
            assets: portfolio,
            summary: {
                totalValue: totalValue.toFixed(0),
                totalPnl: totalPnl.toFixed(0),
                totalPnlPercent: totalPnlPercent.toFixed(2),
                assetCount: portfolio.length
            }
        });
        
    } catch (error) {
        console.error('❌ Get portfolio error:', error);
        res.status(500).json({ error: 'Failed to get portfolio' });
    }
});

// 6. Get Wallet Summary (Cash Balance + Portfolio Value)
app.get('/api/wallet/summary/:userAddress', async (req, res) => {
    try {
        const { userAddress } = req.params;
        
        if (!ethers.utils.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid address' });
        }
        
        // Get cash balance
        const cashBalanceUnits = await contract.getBalance(userAddress);
        const cashBalanceIDR = parseFloat(ethers.utils.formatUnits(cashBalanceUnits, 4));
        
        // Get portfolio value (reuse logic)
        const portfolioRes = await fetch(`http://localhost:${PORT}/api/portfolio/assets/${userAddress}`);
        const portfolioData = await portfolioRes.json();
        const portfolioValue = portfolioData.success ? parseFloat(portfolioData.summary.totalValue) : 0;
        
        const IDR_RATE = 15000;
        const totalWalletValue = (cashBalanceIDR * IDR_RATE) + portfolioValue;
        
        res.json({
            success: true,
            cashBalance: cashBalanceIDR.toFixed(0),
            portfolioValue: portfolioValue.toFixed(0),
            totalValue: totalWalletValue.toFixed(0),
            currency: 'IDR'
        });
        
    } catch (error) {
        console.error('❌ Get wallet summary error:', error);
        res.status(500).json({ error: 'Failed to get wallet summary' });
    }
});

// ==========================================
// CALLBACK HANDLERS (Midtrans Redirect - Fallback)
// ==========================================

// Simple HTML redirect page for Snap callbacks (fallback jika modal tidak support)
function createRedirectHtml(targetUrl, message) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>ORBIT - Processing Payment...</title>
    <meta http-equiv="refresh" content="2;url=${targetUrl}">
    <style>
        body { background: #0b0e11; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #181a20; padding: 24px; border-radius: 12px; text-align: center; border: 1px solid #2b3139; }
        .spinner { width: 40px; height: 40px; border: 3px solid #2b3139; border-top-color: #00d06c; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="card">
        <div class="spinner"></div>
        <div style="font-size: 18px; margin-bottom: 8px;">${message}</div>
        <div style="color: #9ca3af; font-size: 14px;">Redirecting to wallet...</div>
    </div>
</body>
</html>`;
}

app.get('/wallet/success', (req, res) => {
    const { orderId, userAddress } = req.query;
    console.log(`✅ Payment success callback: ${orderId} for ${userAddress}`);
    
    const redirectUrl = `/?route=wallet&paymentSuccess=true&orderId=${orderId}&userAddress=${userAddress}`;
    res.send(createRedirectHtml(redirectUrl, '✅ Pembayaran Berhasil!'));
});

app.get('/wallet/pending', (req, res) => {
    const { orderId, userAddress } = req.query;
    console.log(`⏳ Payment pending callback: ${orderId} for ${userAddress}`);
    
    const redirectUrl = `/?route=wallet&paymentPending=true&orderId=${orderId}&userAddress=${userAddress}`;
    res.send(createRedirectHtml(redirectUrl, '⏳ Menunggu Konfirmasi Pembayaran...'));
});

app.get('/wallet/error', (req, res) => {
    const { orderId, userAddress } = req.query;
    console.log(`❌ Payment error callback: ${orderId} for ${userAddress}`);
    
    const redirectUrl = `/?route=wallet&paymentError=true&orderId=${orderId}&userAddress=${userAddress}`;
    res.send(createRedirectHtml(redirectUrl, '❌ Pembayaran Gagal'));
});

// ==========================================
// SERVE PARTIALS & STATIC
// ==========================================
app.get('/partials/:page', (req, res) => {
    const page = req.params.page;
    const allowed = ['trading', 'market', 'wallet', 'tax', 'news']; // ✅ Tambah 'news'
    if (!allowed.includes(page)) {
        return res.status(404).send('Partial not found');
    }
    res.sendFile(path.join(__dirname, 'public', 'partials', `${page}.html`));
});

// ==========================================
// CATCH-ALL ROUTE - SPA FALLBACK (✅ Express 5.x Compatible)
// ==========================================
app.use((req, res) => {
    // Jangan intercept request API atau file static
    if (req.path.startsWith('/api/') || req.path.includes('.')) {
        return res.status(404).json({ error: 'Endpoint not found' });
    }
    // Serve index.html untuk SPA routing frontend
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// ERROR HANDLING
// ==========================================
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err.stack);
    res.status(500).json({ 
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error' 
    });
});

// ==========================================
// START SERVER
// ==========================================
async function startServer() {
    try {
        // Test blockchain connection
        const network = await provider.getNetwork();
        console.log(`✅ Web3 connected to: ${network.name} (Chain ID: ${network.chainId})`);
        
        // Test contract connection
        const contractCode = await provider.getCode(CONTRACT_ADDRESS);
        if (contractCode === '0x') {
            console.warn('⚠️ Contract not found at address:', CONTRACT_ADDRESS);
        } else {
            console.log('✅ Contract verified at:', CONTRACT_ADDRESS);
        }
        
        // Start Express
        app.listen(PORT, () => {
            console.log(`\n===========================================`);
            console.log(`🚀 ORBIT Server Running!`);
            console.log(`===========================================`);
            console.log(`📍 URL: http://localhost:${PORT}`);
            console.log(`🔗 Contract: ${CONTRACT_ADDRESS}`);
            console.log(`🌐 Network: ${network.name} Testnet`);
            console.log(`💰 Midtrans: ${MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'}`);
            console.log(`===========================================\n`);
        });
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();