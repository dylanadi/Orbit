// public/js/app.js
// ==========================================
// ORBIT - SPA Router & Global State Manager
// ==========================================

const AppState = {
    currentRoute: 'trading',
    userAddress: null,
    provider: null,
    signer: null,
    orbitContract: null,
    cleanupFns: [], // Track cleanup functions per page
    contract: {
        address: "0x7159d337f827e4d8d06d51bdd2d5a219d19d4f68",
        abi: [
            "function executeTrade(string _symbol, string _side, uint256 _price, uint256 _qty) public",
            "function getTrades(address _user) public view returns (tuple(string symbol, string side, uint256 price, uint256 qty, uint256 timestamp)[])"
        ]
    },
    validRoutes: ['trading', 'market', 'wallet', 'tax']
};

// ==========================================
// 1. CORE ROUTER
// ==========================================
async function navigate(route, params = {}) {
    console.log(`[ROUTER] Navigating to: ${route}`, params);
    
    if (!AppState.validRoutes.includes(route)) {
        console.warn(`Invalid route: ${route}, falling back to trading`);
        route = 'trading';
    }

    // 1. Cleanup previous page resources FIRST
    runCleanup();

    // 2. Update sidebar active state
    updateActiveNav(route);

    // 3. Loading UI
    const main = document.getElementById('main-content');
    if (!main) {
        console.error('[ROUTER] #main-content not found in DOM');
        return;
    }
    main.innerHTML = `
        <div class="flex items-center justify-center h-full">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-[#0ecb81]"></div>
        </div>`;

    try {
        // Fetch partial
        const res = await fetch(`/partials/${route}.html`);
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load ${route}.html`);
        const html = await res.text();

        // Inject & update state
        main.innerHTML = html;
        AppState.currentRoute = route;

        // Update URL history (SPA style)
        const url = new URL(window.location);
        if (params?.symbol) {
            url.searchParams.set('symbol', params.symbol.toUpperCase());
        } else {
            url.searchParams.delete('symbol');
        }
        window.history.pushState({ route, params }, '', url);

        // Execute partial scripts SAFELY
        executePartialScripts(main, route);

        // Call route-specific init function exposed by partial
        await initRoute(route, params);

        console.log(`[ROUTER] ✅ Loaded: ${route}`);
    } catch (err) {
        console.error('[ROUTER] ❌ Navigation error:', err);
        if (main) {
            main.innerHTML = `
                <div class="p-8 text-center text-red-500">
                    <div class="text-3xl mb-2">⚠️</div>
                    <div class="font-bold">Gagal memuat halaman</div>
                    <div class="text-sm mt-2 text-gray-400">${err.message}</div>
                    <button onclick="navigate('${route}')" class="mt-4 px-4 py-2 bg-[#2b3139] rounded hover:bg-[#3b4149] transition">Coba Lagi</button>
                </div>`;
        }
    }
}

function updateActiveNav(route) {
    document.querySelectorAll('.nav-link').forEach(el => {
        const isActive = el.dataset.route === route;
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
}

// 🔥 SAFE script execution for SPAs (NO parentNode error)
function executePartialScripts(container, route) {
    const scripts = container.querySelectorAll('script');
    scripts.forEach(oldScript => {
        try {
            const newScript = document.createElement('script');
            if (oldScript.src) {
                newScript.src = oldScript.src;
            } else if (oldScript.textContent) {
                newScript.textContent = oldScript.textContent;
            }
            newScript.async = true;
            document.body.appendChild(newScript);
            
            // Safe cleanup: check existence before remove
            setTimeout(() => {
                if (newScript && newScript.parentNode && typeof newScript.parentNode.removeChild === 'function') {
                    try { newScript.parentNode.removeChild(newScript); } catch(e) {}
                }
            }, 1000);
        } catch (e) {
            console.warn(`[SCRIPT] Failed to execute script for ${route}:`, e);
        }
    });
}

async function initRoute(route, params) {
    // Partials should expose these functions globally
    if (route === 'trading' && typeof window.initTrading === 'function') {
        window.initTrading();
    }
    if (route === 'market' && typeof window.initMarket === 'function') {
        window.initMarket();
    }
    if (route === 'wallet' && typeof window.initWallet === 'function') {
        window.initWallet();
    }
    if (route === 'tax' && typeof window.initTax === 'function') {
        window.initTax();
    }
}

// ==========================================
// 2. WALLET & WEB3 STATE MANAGEMENT
// ==========================================
async function connectWallet() {
    if (!window.ethereum) return alert('🦊 Install MetaMask dulu!');
    try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (accounts?.length > 0) {
            setWalletState(accounts[0]);
            console.log('✅ Wallet connected & synced');
        }
    } catch (err) {
        console.error('[WALLET] Connect failed:', err);
        if (err.code !== 4001) alert('Gagal connect: ' + err.message);
    }
}

// 🔑 CENTRALIZED wallet state sync (FIXES portfolio disappearing)
function setWalletState(address) {
    AppState.userAddress = address;
    window.userAddress = address; // Expose to partials

    if (address) {
        // Initialize ethers instances for WRITE operations
        window.provider = new ethers.providers.Web3Provider(window.ethereum);
        window.signer = window.provider.getSigner();
        window.orbitContract = new ethers.Contract(AppState.contract.address, AppState.contract.abi, window.signer);
        AppState.signer = window.signer;
        AppState.orbitContract = window.orbitContract;
    } else {
        // Clear instances on disconnect
        window.provider = null;
        window.signer = null;
        window.orbitContract = null;
        AppState.signer = null;
        AppState.orbitContract = null;
    }

    // Update Sidebar UI (global, always runs)
    updateSidebarWalletUI(address);

    // Notify ALL partials via event (market, trading, etc.)
    window.dispatchEvent(new CustomEvent('wallet:statusChanged', { 
        detail: { connected: !!address, address } 
    }));
    
    console.log('[WALLET] State synced:', address ? `Connected: ${address.slice(0,8)}...` : 'Disconnected');
}

function updateSidebarWalletUI(address) {
    const btnText = document.getElementById('btn-text');
    const btn = document.getElementById('btn-connect');
    const badge = document.getElementById('network-badge');
    
    if (btnText) {
        btnText.textContent = address ? `${address.slice(0,6)}...${address.slice(-4)}` : 'Connect Wallet';
    }
    if (btn) {
        btn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'bg-[#2b3139]', 'hover:bg-[#3b4149]');
        btn.classList.add(address ? 'bg-[#2b3139]' : 'bg-blue-600');
        btn.classList.add(address ? 'hover:bg-[#3b4149]' : 'hover:bg-blue-700');
    }
    if (badge) {
        badge.classList.toggle('hidden', !address);
    }
}

async function checkExistingConnection() {
    if (!window.ethereum) return;
    try {
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (accounts?.length > 0) {
            console.log('[WALLET] Restoring session:', accounts[0]);
            setWalletState(accounts[0]);
        }
    } catch (e) { 
        console.warn('[WALLET] Session check failed', e); 
    }
}

function setupMetaMaskListeners() {
    if (!window.ethereum) return;
    
    window.ethereum.on('accountsChanged', (accounts) => {
        console.log('[META] accountsChanged:', accounts?.[0] || 'disconnected');
        if (!accounts?.length) {
            setWalletState(null);
            // Optional: reload if not on market (market handles disconnect UI gracefully)
            if (AppState.currentRoute !== 'market') location.reload();
        } else {
            setWalletState(accounts[0]);
        }
    });
    
    window.ethereum.on('chainChanged', () => {
        console.log('[META] chainChanged, reloading...');
        location.reload();
    });
}

// ==========================================
// 3. SPA LIFECYCLE & CLEANUP
// ==========================================
window.registerCleanup = function(fn) {
    if (typeof fn === 'function') AppState.cleanupFns.push(fn);
};

function runCleanup() {
    AppState.cleanupFns.forEach(fn => { 
        try { fn(); } catch(e) { console.warn('[CLEANUP] Error:', e); } 
    });
    AppState.cleanupFns = [];
}

function setupHistoryListener() {
    window.addEventListener('popstate', (e) => {
        if (e.state?.route) {
            navigate(e.state.route, e.state.params || {});
        } else {
            const path = window.location.pathname.replace('/', '') || 'trading';
            const params = Object.fromEntries(new URLSearchParams(window.location.search));
            navigate(path, params);
        }
    });
}

// ==========================================
// 4. UTILITY FUNCTIONS
// ==========================================
window.formatCurrency = function(value, decimals = 2) {
    if (value == null) return '$0.00';
    return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD',
        minimumFractionDigits: decimals, maximumFractionDigits: decimals
    }).format(value);
};

window.formatCrypto = function(value, decimals = 4) {
    if (value == null) return '0';
    return parseFloat(value).toFixed(decimals);
};

window.formatTime = function(timestamp, locale = 'id-ID') {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleTimeString(locale);
};

window.debounce = function(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

// ==========================================
// 5. INITIALIZATION
// ==========================================
function initApp() {
    console.log('[APP] 🚀 Initializing ORBIT...');
    
    setupMetaMaskListeners();
    setupHistoryListener();
    checkExistingConnection(); // Auto-restore wallet session

    const initialRoute = window.location.pathname.replace('/', '') || 'trading';
    const initialParams = Object.fromEntries(new URLSearchParams(window.location.search));
    navigate(initialRoute, initialParams);

    // Expose globals for partials & HTML onclick
    window.navigate = navigate;
    window.connectWallet = connectWallet;
    window.setWalletState = setWalletState;
    
    console.log('[APP] ✅ Ready');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Global cleanup on page unload
window.addEventListener('beforeunload', () => {
    console.log('[APP] 🧹 Cleaning up...');
    runCleanup();
});

// Export for module usage (optional)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AppState, navigate, connectWallet, setWalletState };
}