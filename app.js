// ═══════════════════════════════════════════════════════════
// Albion Market Flipper — Core Application
// ═══════════════════════════════════════════════════════════

const API_SERVERS = {
  west: 'https://west.albion-online-data.com/api/v2/stats/prices',
  europe: 'https://europe.albion-online-data.com/api/v2/stats/prices',
  east: 'https://east.albion-online-data.com/api/v2/stats/prices'
};
let currentServer = 'west';
const CITIES = ['Caerleon', 'Bridgewatch', 'Martlock', 'Fort Sterling', 'Lymhurst', 'Thetford', 'Black Market', 'Brecilien'];
const BATCH_SIZE = 80;       // Max items per API call (API limit is ~100)
const BATCH_DELAY = 350;     // ms between batches to respect rate limits
const CACHE_TTL = 5 * 60 * 1000; // 5 minute cache

// ─── STATE ───
let priceCache = {};         // { itemId_city_quality: { data, timestamp } }
let currentResults = [];     // Current filtered+sorted results
let currentSort = 'profit';
let consumed = new Set();     // Flips consumed this session
let scanning = false;
let lastScanTime = null;

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

const BLACK_MARKET_CATEGORIES = [
  'Warrior Weapons', 'Mage Weapons', 'Hunter Weapons', 'Accessories', 'Armor', 'Bags & Capes'
];

const WEAPON_CATEGORIES = ['Warrior Weapons', 'Mage Weapons', 'Hunter Weapons', 'Accessories'];

document.addEventListener('DOMContentLoaded', () => {
  buildCategoryCheckboxes();
  document.getElementById('multiRouteToggle').addEventListener('change', (e) => {
    document.getElementById('singleRouteControls').style.display = e.target.checked ? 'none' : 'block';
  });
  document.getElementById('premiumTax').addEventListener('change', updateTaxLabel);
  document.getElementById('destCity').addEventListener('change', onDestCityChange);
  onDestCityChange(); // Apply category filter for default destination

  // Initialize farming sidebar
  populateFarmProducts();
  document.getElementById('farmCity').addEventListener('change', updateFarmBonusInfo);
  document.getElementById('farmFocus').addEventListener('change', (e) => {
    document.getElementById('farmFocusReturnRow').style.display = e.target.checked ? '' : 'none';
  });
});

function onDestCityChange() {
  const dest = document.getElementById('destCity').value;
  const isBlackMarket = dest === 'Black Market';
  document.querySelectorAll('#categoryGrid input[type="checkbox"]').forEach(cb => {
    const label = cb.closest('label') || cb.parentElement;
    if (cb.dataset.weaponGroup) {
      cb.checked = true;
      if (label && label.tagName === 'LABEL') label.style.display = '';
    } else if (cb.value) {
      const allowed = BLACK_MARKET_CATEGORIES.includes(cb.value);
      if (isBlackMarket) {
        cb.checked = allowed;
        if (label && label.tagName === 'LABEL') label.style.display = allowed ? '' : 'none';
      } else {
        if (label && label.tagName === 'LABEL') label.style.display = '';
      }
    }
  });
  // Also hide hidden weapon sub-checkboxes (they have no label to hide)
}

function buildCategoryCheckboxes() {
  const grid = document.getElementById('categoryGrid');
  const categories = getCategoryNames();
  let html = '';
  let weaponsDone = false;

  for (const cat of categories) {
    if (WEAPON_CATEGORIES.includes(cat)) {
      if (weaponsDone) continue;
      weaponsDone = true;
      // Combined "Weapons" group with all three weapon categories as hidden checkboxes
      const totalCount = WEAPON_CATEGORIES.reduce((sum, wc) => sum + getItemsByCategories([wc]).length, 0);
      html += `<label><input type="checkbox" id="cat_Weapons" data-weapon-group="true" checked onchange="toggleWeaponGroup(this)"> Weapons & Accessories <span style="color:var(--text-muted); font-size:11px;">(${totalCount})</span></label>`;
      // Hidden checkboxes for each weapon subcategory
      for (const wc of WEAPON_CATEGORIES) {
        const id = `cat_${wc.replace(/[^a-zA-Z0-9]/g, '_')}`;
        html += `<input type="checkbox" id="${id}" value="${wc}" checked style="display:none;">`;
      }
    } else {
      const id = `cat_${cat.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const count = getItemsByCategories([cat]).length;
      html += `<label><input type="checkbox" id="${id}" value="${cat}" checked> ${cat} <span style="color:var(--text-muted); font-size:11px;">(${count})</span></label>`;
    }
  }
  grid.innerHTML = html;
}

function toggleWeaponGroup(el) {
  for (const wc of WEAPON_CATEGORIES) {
    const id = `cat_${wc.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const cb = document.getElementById(id);
    if (cb) cb.checked = el.checked;
  }
}

function selectAllCategories() {
  document.querySelectorAll('#categoryGrid input[type="checkbox"]').forEach(cb => cb.checked = true);
}

function deselectAllCategories() {
  document.querySelectorAll('#categoryGrid input[type="checkbox"]').forEach(cb => cb.checked = false);
}

// ═══════════════════════════════════════════════════════════
// API CLIENT — Batching + Caching
// ═══════════════════════════════════════════════════════════

function getCacheKey(itemId, city, quality) {
  return `${itemId}__${city}__${quality}`;
}

function getCachedPrice(itemId, city, quality) {
  const key = getCacheKey(itemId, city, quality);
  const entry = priceCache[key];
  if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCachedPrice(itemId, city, quality, data) {
  const key = getCacheKey(itemId, city, quality);
  priceCache[key] = { data, timestamp: Date.now() };
}

async function fetchPricesBatch(itemIds, locations) {
  const itemList = itemIds.join(',');
  const locList = locations.join(',');
  const url = `${API_SERVERS[currentServer]}/${itemList}?locations=${locList}&qualities=1,2,3,4,5`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  const data = await response.json();

  // Cache each result
  for (const entry of data) {
    setCachedPrice(entry.item_id, entry.city, entry.quality, entry);
  }

  return data;
}

async function fetchAllPrices(itemIds, locations, onProgress) {
  // Split items into batches
  const batches = [];
  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    batches.push(itemIds.slice(i, i + BATCH_SIZE));
  }

  const allData = [];
  let completed = 0;

  for (const batch of batches) {
    // Check which items we already have cached for all requested locations
    const uncachedItems = batch.filter(itemId => {
      return locations.some(loc => !getCachedPrice(itemId, loc, 1));
    });

    if (uncachedItems.length > 0) {
      try {
        const data = await fetchPricesBatch(uncachedItems, locations);
        allData.push(...data);
      } catch (err) {
        console.warn('Batch fetch error:', err);
        // Continue with remaining batches
      }

      // Rate limit delay
      if (completed < batches.length - 1) {
        await sleep(BATCH_DELAY);
      }
    }

    // Pull from cache for the full batch
    for (const itemId of batch) {
      for (const loc of locations) {
        for (let q = 1; q <= 5; q++) {
          const cached = getCachedPrice(itemId, loc, q);
          if (cached && !allData.find(d => d.item_id === cached.item_id && d.city === cached.city && d.quality === cached.quality)) {
            allData.push(cached);
          }
        }
      }
    }

    completed++;
    if (onProgress) {
      onProgress(completed / batches.length);
    }
  }

  return allData;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════
// PROFIT CALCULATION ENGINE
// ═══════════════════════════════════════════════════════════

function getTaxRate() {
  const premium = document.getElementById('premiumTax').checked;
  return premium ? 0.04 : 0.08;
}

function updateTaxLabel() {
  const premium = document.getElementById('premiumTax').checked;
  const info = document.getElementById('taxInfo');
  info.innerHTML = premium ? 'Tax: <strong>4%</strong>' : 'Tax: <strong>8%</strong>';
}

function calculateFlips(priceData, originCity, destCity) {
  // Group prices by item+quality
  const priceMap = {};
  for (const entry of priceData) {
    const key = `${entry.item_id}__${entry.quality}`;
    if (!priceMap[key]) priceMap[key] = {};
    priceMap[key][entry.city] = entry;
  }

  const flips = [];

  for (const [key, cityPrices] of Object.entries(priceMap)) {
    const originData = cityPrices[originCity];
    const destData = cityPrices[destCity];

    if (!originData || !destData) continue;

    // Buy at origin: use sell_price_min (cheapest sell order = what we buy from)
    const buyPrice = originData.sell_price_min;
    // Sell at destination: use buy_price_max (highest buy order = what we sell to instantly)
    // Also consider sell_price_min at destination for undercutting sell orders
    const sellPriceInstant = destData.buy_price_max;
    const sellPriceSellOrder = destData.sell_price_min;

    if (!buyPrice || buyPrice <= 0) continue;

    // Use instant sell (buy order) as primary, fall back to sell order pricing
    let sellPrice = sellPriceInstant;
    let sellType = 'instant';

    if ((!sellPrice || sellPrice <= 0) && sellPriceSellOrder > 0) {
      sellPrice = sellPriceSellOrder;
      sellType = 'order';
    }

    if (!sellPrice || sellPrice <= 0) continue;

    // Calculate tax
    const taxRate = getTaxRate();
    const taxAmount = Math.floor(sellPrice * taxRate);
    const netSellPrice = sellPrice - taxAmount;

    const profit = netSellPrice - buyPrice;
    const margin = (profit / buyPrice) * 100;

    if (profit <= 0) continue;

    flips.push({
      itemId: originData.item_id,
      quality: originData.quality,
      itemName: formatItemName(originData.item_id),
      originCity,
      destCity,
      buyPrice,
      sellPrice,
      netSellPrice,
      taxAmount,
      profit,
      margin,
      sellType,
      tier: getItemTier(originData.item_id),
      enchantment: getItemEnchantment(originData.item_id),
      buyDate: originData.sell_price_min_date,
      sellDate: destData.buy_price_max_date
    });
  }

  return flips;
}

// ═══════════════════════════════════════════════════════════
// ENCHANT FLIP CALCULATION
// ═══════════════════════════════════════════════════════════

function calculateEnchantFlips(priceData, city, matCount) {
  // Build price lookup: itemId -> { sell_price_min, buy_price_max }
  const priceMap = {};
  for (const entry of priceData) {
    if (entry.city !== city) continue;
    if (entry.quality !== 1) continue; // Only normal quality for enchant flips
    priceMap[entry.item_id] = entry;
  }

  // Get material prices
  const matPrices = {};
  for (let tier = 4; tier <= 8; tier++) {
    matPrices[tier] = {
      rune: priceMap[`T${tier}_RUNE`]?.sell_price_min || 0,
      soul: priceMap[`T${tier}_SOUL`]?.sell_price_min || 0,
      relic: priceMap[`T${tier}_RELIC`]?.sell_price_min || 0
    };
  }

  const flips = [];
  const upgradePaths = [
    { from: 0, to: 1, mats: ['rune'] },
    { from: 0, to: 2, mats: ['rune', 'soul'] },
    { from: 0, to: 3, mats: ['rune', 'soul', 'relic'] },
    { from: 1, to: 2, mats: ['soul'] },
    { from: 1, to: 3, mats: ['soul', 'relic'] },
    { from: 2, to: 3, mats: ['relic'] }
  ];

  // Find all base items in the price data (items without @ that are equipment)
  const baseItems = new Set();
  for (const entry of priceData) {
    if (entry.city !== city || entry.quality !== 1) continue;
    const baseId = getBaseItemId(entry.item_id);
    const tier = getItemTier(baseId);
    if (tier >= 4) baseItems.add(baseId);
  }

  for (const baseId of baseItems) {
    // Skip enchanting materials themselves
    if (baseId.match(/T\d_(RUNE|SOUL|RELIC)$/)) continue;

    const tier = getItemTier(baseId);
    if (!matPrices[tier]) continue;

    for (const path of upgradePaths) {
      const fromId = path.from === 0 ? baseId : `${baseId}@${path.from}`;
      const toId = `${baseId}@${path.to}`;

      const fromData = priceMap[fromId];
      const toData = priceMap[toId];

      if (!fromData || !toData) continue;

      const buyPrice = fromData.sell_price_min;
      if (!buyPrice || buyPrice <= 0) continue;

      // Calculate material costs
      let materialCost = 0;
      const matDetails = [];
      for (const mat of path.mats) {
        const matPrice = matPrices[tier][mat];
        if (!matPrice || matPrice <= 0) continue;
        const cost = matCount * matPrice;
        materialCost += cost;
        matDetails.push({ type: mat, count: matCount, unitPrice: matPrice, totalCost: cost });
      }

      // Sell price: prefer buy orders (instant sell)
      let sellPrice = toData.buy_price_max;
      let sellType = 'instant';
      if (!sellPrice || sellPrice <= 0) {
        sellPrice = toData.sell_price_min;
        sellType = 'order';
      }
      if (!sellPrice || sellPrice <= 0) continue;

      const taxRate = getTaxRate();
      const taxAmount = Math.floor(sellPrice * taxRate);
      const netSellPrice = sellPrice - taxAmount;
      const totalCost = buyPrice + materialCost;
      const profit = netSellPrice - totalCost;
      const margin = (profit / totalCost) * 100;

      if (profit <= 0) continue;

      flips.push({
        itemId: baseId,
        quality: 1,
        itemName: formatItemName(baseId),
        originCity: city,
        destCity: city,
        buyPrice,
        sellPrice,
        netSellPrice,
        taxAmount,
        profit,
        margin,
        sellType,
        tier,
        enchantment: 0,
        buyDate: fromData.sell_price_min_date,
        sellDate: toData.buy_price_max_date,
        // Enchant-specific fields
        isEnchantFlip: true,
        enchantFrom: path.from,
        enchantTo: path.to,
        materialCost,
        matDetails,
        fromItemId: fromId,
        toItemId: toId
      });
    }
  }

  return flips;
}

// ═══════════════════════════════════════════════════════════
// SCANNING
// ═══════════════════════════════════════════════════════════

async function startScan() {
  if (scanning) return;

  // Gather selected items
  const selectedCategories = [];
  document.querySelectorAll('#categoryGrid input:checked').forEach(cb => {
    selectedCategories.push(cb.value);
  });

  let itemIds = getItemsByCategories(selectedCategories);

  if (itemIds.length === 0) {
    setStatus('No items selected. Check at least one category.');
    return;
  }

  const multiRoute = document.getElementById('multiRouteToggle').checked;
  scanning = true;
  document.getElementById('scanBtn').disabled = true;
  document.getElementById('scanBtn').textContent = 'Scanning...';

  let allFlips = [];

  if (multiRoute) {
    // Fetch prices for ALL cities
    setStatus(`Scanning ${itemIds.length} items across all cities...`);
    showProgress(true);

    try {
      const priceData = await fetchAllPrices(itemIds, CITIES, (pct) => {
        updateProgress(pct);
      });

      // Calculate flips for every city pair (Black Market is sell-only)
      for (const origin of CITIES) {
        if (origin === 'Black Market') continue;
        for (const dest of CITIES) {
          if (origin === dest) continue;
          const flips = calculateFlips(priceData, origin, dest);
          allFlips.push(...flips);
        }
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      scanning = false;
      resetScanButton();
      showProgress(false);
      return;
    }
  } else {
    const originCity = document.getElementById('originCity').value;
    const destCity = document.getElementById('destCity').value;

    if (originCity === destCity) {
      setStatus('Origin and destination must be different cities.');
      scanning = false;
      resetScanButton();
      return;
    }

    setStatus(`Scanning ${itemIds.length} items: ${originCity} → ${destCity}...`);
    showProgress(true);

    try {
      const priceData = await fetchAllPrices(itemIds, [originCity, destCity], (pct) => {
        updateProgress(pct);
      });

      allFlips = calculateFlips(priceData, originCity, destCity);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      scanning = false;
      resetScanButton();
      showProgress(false);
      return;
    }
  }

  // ─── ENCHANT FLIPS ───
  const enchantEnabled = document.getElementById('enchantFlipToggle').checked;
  if (enchantEnabled) {
    const enchantCities = multiRoute
      ? CITIES.filter(c => c !== 'Black Market')
      : [document.getElementById('originCity').value];
    const matCount = 48;
    const enchantableItems = getEnchantableItems(selectedCategories);

    if (enchantableItems.length > 0) {
      // Build list of all enchanted variants + materials to fetch
      const enchantItemIds = [];
      const materialIds = new Set();
      for (const baseId of enchantableItems) {
        enchantItemIds.push(baseId);
        enchantItemIds.push(`${baseId}@1`);
        enchantItemIds.push(`${baseId}@2`);
        enchantItemIds.push(`${baseId}@3`);
        const tier = getItemTier(baseId);
        if (tier >= 4) {
          materialIds.add(`T${tier}_RUNE`);
          materialIds.add(`T${tier}_SOUL`);
          materialIds.add(`T${tier}_RELIC`);
        }
      }
      enchantItemIds.push(...materialIds);

      for (const enchantCity of enchantCities) {
        setStatus(`Scanning enchant upgrades in ${enchantCity}...`);
        showProgress(true);
        try {
          const enchantPriceData = await fetchAllPrices(enchantItemIds, [enchantCity], (pct) => {
            updateProgress(pct);
          });
          const enchantFlips = calculateEnchantFlips(enchantPriceData, enchantCity, matCount);
          allFlips.push(...enchantFlips);
        } catch (err) {
          console.warn('Enchant flip scan error:', err);
        }
      }
    }
  }

  lastScanTime = Date.now();
  scanning = false;
  resetScanButton();
  showProgress(false);
  document.getElementById('refreshBtn').style.display = 'block';

  // Apply filters and display
  currentResults = allFlips;
  applyFiltersAndRender();
  startAgeTimer();
}

async function refreshData() {
  // Clear cache and re-scan
  priceCache = {};
  await startScan();
}

function resetScanButton() {
  document.getElementById('scanBtn').disabled = false;
  document.getElementById('scanBtn').textContent = 'Scan Market';
}

// ═══════════════════════════════════════════════════════════
// FILTERING & SORTING
// ═══════════════════════════════════════════════════════════

function applyFiltersAndRender() {
  const minProfit = parseInt(document.getElementById('minProfit').value) || 0;
  const minMargin = parseFloat(document.getElementById('minMargin').value) || 0;
  const tierFilter = document.getElementById('tierFilter').value;
  const enchantFilter = document.getElementById('enchantFilter').value;

  let filtered = currentResults.filter(flip => {
    if (flip.profit < minProfit) return false;
    if (flip.margin < minMargin) return false;
    if (tierFilter !== 'all' && flip.tier !== parseInt(tierFilter)) return false;
    if (enchantFilter !== 'all' && flip.enchantment !== parseInt(enchantFilter)) return false;
    const consumeKey = `${flip.itemId}__${flip.quality}__${flip.originCity}__${flip.destCity}`;
    if (consumed.has(consumeKey)) return false;
    return true;
  });

  // Deduplicate: for each item+quality+route keep only best quality entry
  // Actually, show all but sort
  sortResults(filtered);
  renderResults(filtered);

  const multiRoute = document.getElementById('multiRouteToggle').checked;
  const originCity = document.getElementById('originCity').value;
  const destCity = document.getElementById('destCity').value;
  const routeStr = multiRoute ? 'all routes' : `${originCity} → ${destCity}`;

  setStatus(`Found <strong>${filtered.length}</strong> profitable flips (${routeStr})`);
}

function sortResults(results) {
  switch (currentSort) {
    case 'profit':
      results.sort((a, b) => b.profit - a.profit);
      break;
    case 'margin':
      results.sort((a, b) => b.margin - a.margin);
      break;
    case 'age':
      results.sort((a, b) => {
        const aDate = Math.max(new Date(a.buyDate || 0).getTime(), new Date(a.sellDate || 0).getTime());
        const bDate = Math.max(new Date(b.buyDate || 0).getTime(), new Date(b.sellDate || 0).getTime());
        return bDate - aDate;
      });
      break;
  }
}

function setSort(sort) {
  currentSort = sort;
  document.querySelectorAll('.sort-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.sort === sort);
  });
  applyFiltersAndRender();
}

// ═══════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════

function renderResults(flips) {
  const container = document.getElementById('resultsContainer');
  const sortBar = document.getElementById('sortBar');

  if (flips.length === 0) {
    sortBar.style.display = 'none';
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#x1F50D;</div>
        <h3>No Profitable Flips Found</h3>
        <p>Try lowering the minimum profit/margin, selecting more categories, or scanning different routes.</p>
      </div>
    `;
    return;
  }

  sortBar.style.display = 'flex';

  const multiRoute = document.getElementById('multiRouteToggle').checked;

  if (multiRoute) {
    // Group by route
    const routeGroups = {};
    for (const flip of flips) {
      const routeKey = `${flip.originCity} → ${flip.destCity}`;
      if (!routeGroups[routeKey]) routeGroups[routeKey] = [];
      routeGroups[routeKey].push(flip);
    }

    // Sort routes by total profit
    const sortedRoutes = Object.entries(routeGroups).sort((a, b) => {
      const totalA = a[1].reduce((s, f) => s + f.profit, 0);
      const totalB = b[1].reduce((s, f) => s + f.profit, 0);
      return totalB - totalA;
    });

    let html = '';
    for (const [routeName, routeFlips] of sortedRoutes) {
      const [origin, dest] = routeName.split(' → ');
      const totalProfit = routeFlips.reduce((s, f) => s + f.profit, 0);
      html += `
        <div class="route-header">
          <span class="route-city city-tag city-${origin.replace(/\s/g, '')}">${origin}</span>
          <span class="route-arrow">→</span>
          <span class="route-city city-tag city-${dest.replace(/\s/g, '')}">${dest}</span>
          <span class="route-count">${routeFlips.length} items · ${formatSilver(totalProfit)} total profit</span>
        </div>
      `;
      html += buildTable(routeFlips, false);
      html += '<div style="height: 20px;"></div>';
    }

    container.innerHTML = html;
  } else {
    container.innerHTML = buildTable(flips, true);
  }
}

function buildTable(flips, showRoute) {
  const qualityNames = { 1: 'Normal', 2: 'Good', 3: 'Outstanding', 4: 'Excellent', 5: 'Masterpiece' };
  const hasEnchantFlips = flips.some(f => f.isEnchantFlip);

  let html = `
    <div class="results-table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>${hasEnchantFlips ? 'Type' : 'Quality'}</th>
          ${showRoute ? '<th>Buy In</th><th>Sell In</th>' : ''}
          <th>Buy Price</th>
          <th>Sell Price</th>
          <th>Tax</th>
          <th>Profit</th>
          <th>Margin</th>
          <th>Data Age</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const flip of flips) {
    const marginClass = flip.margin >= 20 ? 'margin-high' : flip.margin >= 10 ? 'margin-medium' : 'margin-low';
    const rowClass = flip.margin >= 20 ? 'high-profit' : '';
    const buyAge = getRelativeTime(flip.buyDate);
    const sellAge = getRelativeTime(flip.sellDate);
    const oldestAge = buyAge.includes('day') || sellAge.includes('day') ? 'stale' : '';

    // Type column content
    let typeCol = '';
    if (flip.isEnchantFlip) {
      const matNames = { rune: 'Rune', soul: 'Soul', relic: 'Relic' };
      const matLabels = flip.matDetails.map(m => {
        const matId = `T${flip.tier}_${m.type.toUpperCase()}`;
        return `<span class="mat-item"><img class="mat-icon" src="${getItemIconUrl(matId)}" alt="${matNames[m.type]}">${m.count}x T${flip.tier} ${matNames[m.type]} <span class="mat-price">${formatSilver(m.unitPrice)} ea</span></span>`;
      }).join('<span class="mat-sep">+</span>');
      typeCol = `
        <div class="enchant-path">
          <span class="enchant-level enchant-${flip.enchantFrom}">.${flip.enchantFrom}</span>
          <span class="enchant-arrow">&#9654;</span>
          <span class="enchant-level enchant-${flip.enchantTo}">.${flip.enchantTo}</span>
        </div>
        <div class="mat-cost">${matLabels}</div>
      `;
    } else {
      typeCol = qualityNames[flip.quality] || flip.quality;
    }

    // For enchant flips, show the target enchanted item icon
    const iconItemId = flip.isEnchantFlip ? flip.toItemId : flip.itemId;
    // Consume key suffix for enchant flips to make unique
    const consumeDest = flip.isEnchantFlip
      ? `${flip.destCity}_E${flip.enchantFrom}to${flip.enchantTo}`
      : flip.destCity;

    html += `
      <tr class="${rowClass}">
        <td><div class="item-cell"><img class="item-icon" src="${getItemIconUrl(iconItemId)}" alt="" loading="lazy"><span class="item-name">${flip.itemName}</span></div></td>
        <td style="color:var(--text-secondary); font-size:12px;">${typeCol}</td>
        ${showRoute ? `
          <td><span class="city-tag city-${flip.originCity.replace(/\s/g, '')}">${flip.originCity}</span></td>
          <td><span class="city-tag city-${flip.destCity.replace(/\s/g, '')}">${flip.destCity}</span></td>
        ` : ''}
        <td class="price">${formatSilver(flip.buyPrice)}${flip.isEnchantFlip ? `<br><span class="mat-cost">+${formatSilver(flip.materialCost)} mats</span>` : ''}</td>
        <td class="price">${formatSilver(flip.sellPrice)} <span style="font-size:10px; color:var(--text-muted);">${flip.sellType === 'instant' ? 'buy' : 'sell'}</span></td>
        <td class="price" style="color:var(--red); font-size:12px;">-${formatSilver(flip.taxAmount)}</td>
        <td class="price profit-positive">+${formatSilver(flip.profit)}</td>
        <td><span class="margin-badge ${marginClass}">${flip.margin.toFixed(1)}%</span></td>
        <td class="data-age"><span class="dot ${oldestAge}"></span> ${buyAge}</td>
        <td style="text-align:center;"><button class="consume-btn" onclick="consumeFlip(this, '${flip.itemId}', ${flip.quality}, '${flip.originCity}', '${consumeDest}')">Done</button></td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  return html;
}

function consumeFlip(btn, itemId, quality, origin, dest) {
  btn.classList.add('clicked');
  btn.disabled = true;
  setTimeout(() => {
    const key = `${itemId}__${quality}__${origin}__${dest}`;
    consumed.add(key);
    applyFiltersAndRender();
  }, 400);
}

function getItemIconUrl(itemId) {
  return `https://render.albiononline.com/v1/item/${itemId}.png?size=64`;
}

// ═══════════════════════════════════════════════════════════
// FARMING CALCULATOR
// ═══════════════════════════════════════════════════════════

const FARM_PLOTS = { 1: 1, 2: 3, 3: 6, 4: 9, 5: 12, 6: 16 };
const SEEDS_PER_PLOT = 9;

// NPC merchant seed/baby prices (fixed costs from farming merchant)
const NPC_SEED_COST = { 1: 2312, 2: 3468, 3: 5780, 4: 8670, 5: 11560, 6: 17340, 7: 26010, 8: 34680 };
const NPC_BABY_COST = { 3: 5780, 4: 8670, 5: 11560, 6: 17340, 7: 26010, 8: 34680 };

// Animal feeding: 9 crops if favorite food, 18 if not
const FEED_AMOUNT_FAVORITE = 9;
const FEED_AMOUNT_NORMAL = 18;

const FARM_CROPS = [
  { tier: 1, name: 'Carrot',  seedId: 'T1_FARM_CARROT_SEED',  productId: 'T1_CARROT' },
  { tier: 2, name: 'Bean',    seedId: 'T2_FARM_BEAN_SEED',    productId: 'T2_BEAN' },
  { tier: 3, name: 'Wheat',   seedId: 'T3_FARM_WHEAT_SEED',   productId: 'T3_WHEAT' },
  { tier: 4, name: 'Turnip',  seedId: 'T4_FARM_TURNIP_SEED',  productId: 'T4_TURNIP' },
  { tier: 5, name: 'Cabbage', seedId: 'T5_FARM_CABBAGE_SEED', productId: 'T5_CABBAGE' },
  { tier: 6, name: 'Potato',  seedId: 'T6_FARM_POTATO_SEED',  productId: 'T6_POTATO' },
  { tier: 7, name: 'Corn',    seedId: 'T7_FARM_CORN_SEED',    productId: 'T7_CORN' },
  { tier: 8, name: 'Pumpkin', seedId: 'T8_FARM_PUMPKIN_SEED', productId: 'T8_PUMPKIN' }
];

const FARM_ANIMALS = [
  { tier: 3, name: 'Chicken', babyId: 'T3_FARM_CHICKEN_BABY', grownId: 'T3_FARM_CHICKEN_GROWN', productId: 'T3_EGG',  productName: 'Hen Egg',    growthHours: 22, favFood: 'Wheat',   favFoodId: 'T3_WHEAT' },
  { tier: 4, name: 'Goat',    babyId: 'T4_FARM_GOAT_BABY',    grownId: 'T4_FARM_GOAT_GROWN',    productId: 'T4_MILK', productName: 'Goat Milk',  growthHours: 44, favFood: 'Turnip',  favFoodId: 'T4_TURNIP' },
  { tier: 5, name: 'Goose',   babyId: 'T5_FARM_GOOSE_BABY',   grownId: 'T5_FARM_GOOSE_GROWN',   productId: 'T5_EGG',  productName: 'Goose Egg',  growthHours: 66, favFood: 'Cabbage', favFoodId: 'T5_CABBAGE' },
  { tier: 6, name: 'Sheep',   babyId: 'T6_FARM_SHEEP_BABY',   grownId: 'T6_FARM_SHEEP_GROWN',   productId: 'T6_MILK', productName: 'Sheep Milk', growthHours: 88, favFood: 'Potato',  favFoodId: 'T6_POTATO' },
  { tier: 7, name: 'Pig',     babyId: 'T7_FARM_PIG_BABY',     grownId: 'T7_FARM_PIG_GROWN',     productId: null,      productName: null,         growthHours: 110, favFood: 'Corn',   favFoodId: 'T7_CORN' },
  { tier: 8, name: 'Cow',     babyId: 'T8_FARM_COW_BABY',     grownId: 'T8_FARM_COW_GROWN',     productId: 'T8_MILK', productName: 'Cow Milk',   growthHours: 132, favFood: 'Pumpkin', favFoodId: 'T8_PUMPKIN' }
];

const FARM_HERBS = [
  { tier: 2, name: 'Arcane Agaric',        seedId: 'T2_FARM_AGARIC_SEED',   productId: 'T2_AGARIC' },
  { tier: 3, name: 'Brightleaf Comfrey',    seedId: 'T3_FARM_COMFREY_SEED',  productId: 'T3_COMFREY' },
  { tier: 4, name: 'Crenellated Burdock',   seedId: 'T4_FARM_BURDOCK_SEED',  productId: 'T4_BURDOCK' },
  { tier: 5, name: 'Dragon Teasel',         seedId: 'T5_FARM_TEASEL_SEED',   productId: 'T5_TEASEL' },
  { tier: 6, name: 'Elusive Foxglove',      seedId: 'T6_FARM_FOXGLOVE_SEED', productId: 'T6_FOXGLOVE' },
  { tier: 7, name: 'Firetouched Mullein',   seedId: 'T7_FARM_MULLEIN_SEED',  productId: 'T7_MULLEIN' },
  { tier: 8, name: 'Ghoul Yarrow',          seedId: 'T8_FARM_YARROW_SEED',   productId: 'T8_YARROW' }
];

const CITY_FARM_BONUSES = {
  'Fort Sterling': { crops: ['Turnip'],   animals: ['Chicken', 'Sheep'], herbs: ['Ghoul Yarrow'] },
  'Lymhurst':      { crops: ['Carrot', 'Pumpkin'],  animals: ['Goose'],  herbs: ['Crenellated Burdock'] },
  'Bridgewatch':   { crops: ['Bean', 'Corn'],        animals: ['Goat'],   herbs: ['Dragon Teasel'] },
  'Martlock':      { crops: ['Wheat', 'Potato'],     animals: ['Cow'],    herbs: ['Elusive Foxglove'] },
  'Thetford':      { crops: ['Cabbage'],  animals: [],       herbs: ['Arcane Agaric', 'Firetouched Mullein'] },
  'Caerleon':      { crops: [],           animals: [],       herbs: ['Brightleaf Comfrey', 'Dragon Teasel', 'Firetouched Mullein'] },
  'Brecilien':     { crops: ['Carrot', 'Bean', 'Wheat', 'Turnip', 'Cabbage', 'Potato', 'Corn', 'Pumpkin'], animals: [], herbs: [] }
};

function getFarmType() {
  return document.getElementById('farmTypeSelect').value; // 'crops', 'animals', or 'herbs'
}

function onFarmTypeChange() {
  populateFarmProducts();
}

function populateFarmProducts() {
  const farmType = getFarmType();
  const select = document.getElementById('farmProduct');
  let items;
  if (farmType === 'animals') items = FARM_ANIMALS;
  else if (farmType === 'herbs') items = FARM_HERBS;
  else items = FARM_CROPS;

  select.innerHTML = items.map(item =>
    `<option value="${item.name}">T${item.tier} ${item.name}</option>`
  ).join('');

  onFarmProductChange();
  updateFarmBonusInfo();
}

function onFarmProductChange() {
  const farmType = getFarmType();
  const productName = document.getElementById('farmProduct').value;
  const info = document.getElementById('farmProductInfo');

  if (farmType === 'animals') {
    const animal = FARM_ANIMALS.find(a => a.name === productName);
    if (animal) {
      const products = animal.productName ? `Produces: ${animal.productName} (7-11 per animal)` : 'Butcher only (no secondary products)';
      const days = Math.floor(animal.growthHours / 24);
      const hours = animal.growthHours % 24;
      const timeStr = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
      info.innerHTML = `${SEEDS_PER_PLOT} babies per pasture &middot; ${timeStr} growth<br>${products}<br>Favorite food: ${animal.favFood} (${FEED_AMOUNT_FAVORITE}/animal, or ${FEED_AMOUNT_NORMAL} other crop)`;
    }
  } else if (farmType === 'herbs') {
    const herb = FARM_HERBS.find(h => h.name === productName);
    if (herb) {
      info.innerHTML = `${SEEDS_PER_PLOT} seeds per herb garden &middot; 22h growth<br>Yield: 3-6 per seed (avg 4.5) &middot; 2x with Premium`;
    }
  } else {
    const crop = FARM_CROPS.find(c => c.name === productName);
    if (crop) {
      info.innerHTML = `${SEEDS_PER_PLOT} seeds per plot &middot; 22h growth<br>Yield: 3-6 per seed (avg 4.5) &middot; 2x with Premium`;
    }
  }

  updateFarmBonusInfo();
}

function updateFarmBonusInfo() {
  const city = document.getElementById('farmCity').value;
  const farmType = getFarmType();
  const productName = document.getElementById('farmProduct').value;
  const bonusInfo = document.getElementById('farmBonusInfo');
  const cityBonus = CITY_FARM_BONUSES[city];

  if (!cityBonus) {
    bonusInfo.classList.remove('visible');
    return;
  }

  const bonusList = farmType === 'animals' ? cityBonus.animals :
                    farmType === 'herbs' ? cityBonus.herbs : cityBonus.crops;
  const typeLabel = farmType === 'animals' ? 'animal' : farmType === 'herbs' ? 'herb' : 'crop';

  if (bonusList.includes(productName)) {
    bonusInfo.innerHTML = `&#10003; ${city} gives <strong>+10% yield bonus</strong> for ${productName}!`;
    bonusInfo.classList.add('visible');
  } else if (bonusList.length > 0) {
    bonusInfo.innerHTML = `${city} ${typeLabel} bonus: ${bonusList.join(', ')}`;
    bonusInfo.classList.add('visible');
  } else {
    bonusInfo.innerHTML = `No ${typeLabel} bonus in ${city}`;
    bonusInfo.classList.add('visible');
  }
}

async function calculateFarming() {
  const city = document.getElementById('farmCity').value;
  const islandLevel = parseInt(document.getElementById('islandLevel').value);
  const farmType = getFarmType();
  const productName = document.getElementById('farmProduct').value;
  const premium = document.getElementById('farmPremium').checked;
  const plotCount = Math.min(parseInt(document.getElementById('farmPlotCount').value) || 1, FARM_PLOTS[islandLevel]);

  const btn = document.getElementById('farmCalcBtn');
  btn.disabled = true;
  btn.textContent = 'Fetching prices...';

  const container = document.getElementById('farmingContent');
  const cityBonus = CITY_FARM_BONUSES[city];

  try {
    if (farmType === 'animals') {
      const animal = FARM_ANIMALS.find(a => a.name === productName);
      if (!animal) throw new Error('Animal not found');

      // Fetch grown animal price, product price, and favorite food price
      const itemsToFetch = [animal.grownId, animal.favFoodId];
      if (animal.productId) itemsToFetch.push(animal.productId);

      const priceData = await fetchPricesBatch(itemsToFetch, [city]);

      const priceMap = {};
      for (const entry of priceData) {
        if (entry.city === city && entry.quality === 1) {
          priceMap[entry.item_id] = entry;
        }
      }

      const babyPrice = NPC_BABY_COST[animal.tier];
      const grownPrice = priceMap[animal.grownId]?.sell_price_min || 0;
      const productPrice = animal.productId ? (priceMap[animal.productId]?.sell_price_min || 0) : 0;
      const foodPrice = priceMap[animal.favFoodId]?.sell_price_min || 0;

      const babiesPerCycle = plotCount * SEEDS_PER_PLOT;
      const feedPerAnimal = FEED_AMOUNT_FAVORITE; // using favorite food
      const avgProductYield = 9; // 7-11 avg, NOT affected by premium
      const hasBonus = cityBonus && cityBonus.animals.includes(productName);
      const bonusMultiplier = hasBonus ? 1.10 : 1.0;

      const totalBabyCost = babiesPerCycle * babyPrice;
      const totalFeedCost = babiesPerCycle * feedPerAnimal * foodPrice;
      const totalCost = totalBabyCost + totalFeedCost;
      const totalGrownRevenue = babiesPerCycle * grownPrice;
      const totalProductRevenue = animal.productId ? Math.floor(babiesPerCycle * avgProductYield * bonusMultiplier) * productPrice : 0;
      const totalRevenue = totalGrownRevenue + totalProductRevenue;
      const profit = totalRevenue - totalCost;
      const growthHours = premium ? animal.growthHours / 2 : animal.growthHours;
      const cyclesPerDay = 24 / growthHours;
      const dailyProfit = Math.floor(profit * cyclesPerDay);
      const monthlyProfit = dailyProfit * 30;

      renderFarmingResults({
        farmType: 'animals',
        animal,
        city,
        plotCount,
        premium,
        hasBonus,
        babiesPerCycle,
        babyPrice,
        grownPrice,
        productPrice,
        foodPrice,
        feedPerAnimal,
        avgProductYield: Math.floor(avgProductYield * bonusMultiplier),
        totalBabyCost,
        totalFeedCost,
        totalCost,
        totalGrownRevenue,
        totalProductRevenue,
        totalRevenue,
        profit,
        growthHours,
        cyclesPerDay,
        dailyProfit,
        monthlyProfit
      });
    } else {
      // Crops and herbs share same calculation logic
      const isHerb = farmType === 'herbs';
      const items = isHerb ? FARM_HERBS : FARM_CROPS;
      const item = items.find(i => i.name === productName);
      if (!item) throw new Error(`${isHerb ? 'Herb' : 'Crop'} not found`);

      // Only fetch product price — seed cost is NPC fixed
      const priceData = await fetchPricesBatch([item.productId], [city]);

      const priceMap = {};
      for (const entry of priceData) {
        if (entry.city === city && entry.quality === 1) {
          priceMap[entry.item_id] = entry;
        }
      }

      const seedPrice = NPC_SEED_COST[item.tier];
      const productPrice = priceMap[item.productId]?.sell_price_min || 0;

      const useFocus = document.getElementById('farmFocus').checked;
      const focusReturnRate = useFocus ? (parseInt(document.getElementById('farmFocusReturn').value) || 0) / 100 : 0;

      const seedsPerCycle = plotCount * SEEDS_PER_PLOT;
      const avgYieldPerSeed = 4.5; // NOT affected by premium
      const bonusList = isHerb ? cityBonus.herbs : cityBonus.crops;
      const hasBonus = cityBonus && bonusList.includes(productName);
      const bonusMultiplier = hasBonus ? 1.10 : 1.0;
      const totalProduct = Math.floor(seedsPerCycle * avgYieldPerSeed * bonusMultiplier);

      // Focus returns seeds, reducing effective cost
      const seedsReturned = useFocus ? Math.floor(seedsPerCycle * focusReturnRate) : 0;
      const effectiveSeedCost = (seedsPerCycle - seedsReturned) * seedPrice;

      const totalRevenue = totalProduct * productPrice;
      const profit = totalRevenue - effectiveSeedCost;
      const growthHours = premium ? 11 : 22; // premium halves growth time
      const cyclesPerDay = 24 / growthHours;
      const dailyProfit = Math.floor(profit * cyclesPerDay);
      const monthlyProfit = dailyProfit * 30;

      renderFarmingResults({
        farmType,
        crop: item,
        city,
        plotCount,
        premium,
        hasBonus,
        useFocus,
        focusReturnRate,
        seedsReturned,
        seedsPerCycle,
        seedPrice,
        productPrice,
        avgYieldPerSeed,
        totalProduct,
        effectiveSeedCost,
        totalRevenue,
        profit,
        growthHours,
        cyclesPerDay,
        dailyProfit,
        monthlyProfit
      });
    }
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9888;</div>
        <h3>Error</h3>
        <p>${err.message}</p>
      </div>
    `;
  }

  btn.disabled = false;
  btn.textContent = 'Calculate Profit';
}

function renderFarmingResults(data) {
  const container = document.getElementById('farmingContent');

  if (data.farmType === 'animals') {
    const animal = data.animal;
    const iconUrl = getItemIconUrl(animal.babyId);
    const grownIconUrl = getItemIconUrl(animal.grownId);
    const productIconUrl = animal.productId ? getItemIconUrl(animal.productId) : '';

    container.innerHTML = `
      <div class="farm-results">
        <div class="farm-card">
          <div class="farm-card-title">
            <img src="${iconUrl}" alt="${animal.name}">
            T${animal.tier} ${animal.name} Farm — ${data.city}
            ${data.hasBonus ? '<span class="farm-bonus-badge">+10% City Bonus</span>' : ''}
          </div>
          <div class="farm-stat-grid">
            <div class="farm-stat">
              <div class="farm-stat-label">Babies Needed</div>
              <div class="farm-stat-value neutral">${data.babiesPerCycle}</div>
              <div class="farm-stat-sub">${data.plotCount} pasture${data.plotCount > 1 ? 's' : ''} &times; ${SEEDS_PER_PLOT} per pasture</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">Growth Time</div>
              <div class="farm-stat-value neutral">${data.growthHours}h</div>
              <div class="farm-stat-sub">${data.premium ? 'Premium (halved)' : 'Standard'}</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">Baby Price (NPC)</div>
              <div class="farm-stat-value neutral">${formatSilver(data.babyPrice)}</div>
              <div class="farm-stat-sub">per baby animal</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">Feed Cost (${animal.favFood})</div>
              <div class="farm-stat-value neutral">${formatSilver(data.foodPrice)}</div>
              <div class="farm-stat-sub">${data.feedPerAnimal} per animal (fav food)</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">Grown Price</div>
              <div class="farm-stat-value neutral">${formatSilver(data.grownPrice)}</div>
              <div class="farm-stat-sub">sell grown animal</div>
            </div>
            ${animal.productId ? `
            <div class="farm-stat">
              <div class="farm-stat-label">${animal.productName} Price</div>
              <div class="farm-stat-value neutral">${formatSilver(data.productPrice)}</div>
              <div class="farm-stat-sub">~${data.avgProductYield} per animal${data.hasBonus ? ' (with bonus)' : ''}</div>
            </div>
            ` : ''}
            <div class="farm-stat full-width">
              <div class="farm-stat-label">Profit per Cycle (${data.growthHours}h)</div>
              <div class="farm-stat-value ${data.profit >= 0 ? 'positive' : 'negative'}">${data.profit >= 0 ? '+' : ''}${formatSilver(data.profit)}</div>
              <div class="farm-stat-sub">~${data.cyclesPerDay.toFixed(2)} cycles/day${data.premium ? ' (premium)' : ''}</div>
            </div>
          </div>
          <div class="farm-breakdown">
            <div class="farm-breakdown-row"><span class="label">Baby cost (${data.babiesPerCycle} &times; ${formatSilver(data.babyPrice)} NPC)</span><span class="value" style="color:var(--red);">-${formatSilver(data.totalBabyCost)}</span></div>
            <div class="farm-breakdown-row"><span class="label">Feed cost (${data.babiesPerCycle} &times; ${data.feedPerAnimal} ${animal.favFood} &times; ${formatSilver(data.foodPrice)})</span><span class="value" style="color:var(--red);">-${formatSilver(data.totalFeedCost)}</span></div>
            <div class="farm-breakdown-row"><span class="label">Grown animal revenue</span><span class="value" style="color:var(--green);">+${formatSilver(data.totalGrownRevenue)}</span></div>
            ${animal.productId ? `<div class="farm-breakdown-row"><span class="label">${animal.productName} revenue</span><span class="value" style="color:var(--green);">+${formatSilver(data.totalProductRevenue)}</span></div>` : ''}
            <div class="farm-breakdown-row" style="border-top:1px solid var(--border); padding-top:8px; margin-top:4px;">
              <span class="label" style="font-weight:700; color:var(--text-primary);">Net Profit per Cycle</span>
              <span class="value" style="color:${data.profit >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:16px;">${data.profit >= 0 ? '+' : ''}${formatSilver(data.profit)}</span>
            </div>
            <div class="farm-breakdown-row">
              <span class="label" style="font-weight:700; color:var(--text-primary);">Daily Profit</span>
              <span class="value" style="color:${data.dailyProfit >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:16px;">${data.dailyProfit >= 0 ? '+' : ''}${formatSilver(data.dailyProfit)}</span>
            </div>
            <div class="farm-breakdown-row" style="border-top:1px solid var(--border); padding-top:8px; margin-top:4px;">
              <span class="label" style="font-weight:700; color:var(--accent); font-size:15px;">Monthly Profit (30d)</span>
              <span class="value" style="color:${data.monthlyProfit >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:18px; font-weight:700;">${data.monthlyProfit >= 0 ? '+' : ''}${formatSilver(data.monthlyProfit)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  } else {
    const crop = data.crop;
    const seedIconUrl = getItemIconUrl(crop.seedId);
    const productIconUrl = getItemIconUrl(crop.productId);

    container.innerHTML = `
      <div class="farm-results">
        <div class="farm-card">
          <div class="farm-card-title">
            <img src="${productIconUrl}" alt="${crop.name}">
            T${crop.tier} ${crop.name} ${data.farmType === 'herbs' ? 'Herb Garden' : 'Farm'} — ${data.city}
            ${data.hasBonus ? '<span class="farm-bonus-badge">+10% City Bonus</span>' : ''}
          </div>
          <div class="farm-stat-grid">
            <div class="farm-stat">
              <div class="farm-stat-label">Seeds Needed</div>
              <div class="farm-stat-value neutral">${data.seedsPerCycle}</div>
              <div class="farm-stat-sub">${data.plotCount} plot${data.plotCount > 1 ? 's' : ''} &times; ${SEEDS_PER_PLOT} per plot</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">Avg Yield / Seed</div>
              <div class="farm-stat-value neutral">${data.avgYieldPerSeed}</div>
              <div class="farm-stat-sub">${data.hasBonus ? '+10% city bonus' : 'Base yield'}</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">Seed Price (NPC)</div>
              <div class="farm-stat-value neutral">${formatSilver(data.seedPrice)}</div>
              <div class="farm-stat-sub">per seed (merchant)</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">${crop.name} Price</div>
              <div class="farm-stat-value neutral">${formatSilver(data.productPrice)}</div>
              <div class="farm-stat-sub">per unit (sell order)</div>
            </div>
            <div class="farm-stat">
              <div class="farm-stat-label">Total Harvest</div>
              <div class="farm-stat-value neutral">${data.totalProduct}</div>
              <div class="farm-stat-sub">${data.seedsPerCycle} seeds &times; ${data.avgYieldPerSeed} avg</div>
            </div>
            <div class="farm-stat full-width">
              <div class="farm-stat-label">Profit per Cycle (${data.growthHours}h)</div>
              <div class="farm-stat-value ${data.profit >= 0 ? 'positive' : 'negative'}">${data.profit >= 0 ? '+' : ''}${formatSilver(data.profit)}</div>
              <div class="farm-stat-sub">~${data.cyclesPerDay.toFixed(2)} cycles/day${data.premium ? ' (premium)' : ''}</div>
            </div>
          </div>
          <div class="farm-breakdown">
            <div class="farm-breakdown-row"><span class="label">Seed cost (${data.seedsPerCycle} &times; ${formatSilver(data.seedPrice)} NPC${data.useFocus ? `, -${data.seedsReturned} returned` : ''})</span><span class="value" style="color:var(--red);">-${formatSilver(data.effectiveSeedCost)}</span></div>
            ${data.useFocus ? `<div class="farm-breakdown-row"><span class="label" style="color:var(--blue);">Focus: ${data.seedsReturned} seeds returned (${Math.round(data.focusReturnRate * 100)}%)</span><span class="value" style="color:var(--blue);">saves ${formatSilver(data.seedsReturned * data.seedPrice)}</span></div>` : ''}
            <div class="farm-breakdown-row"><span class="label">${data.farmType === 'herbs' ? 'Herb' : 'Crop'} revenue (${data.totalProduct} &times; ${formatSilver(data.productPrice)})</span><span class="value" style="color:var(--green);">+${formatSilver(data.totalRevenue)}</span></div>
            <div class="farm-breakdown-row" style="border-top:1px solid var(--border); padding-top:8px; margin-top:4px;">
              <span class="label" style="font-weight:700; color:var(--text-primary);">Net Profit per Cycle</span>
              <span class="value" style="color:${data.profit >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:16px;">${data.profit >= 0 ? '+' : ''}${formatSilver(data.profit)}</span>
            </div>
            <div class="farm-breakdown-row">
              <span class="label" style="font-weight:700; color:var(--text-primary);">Daily Profit</span>
              <span class="value" style="color:${data.dailyProfit >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:16px;">${data.dailyProfit >= 0 ? '+' : ''}${formatSilver(data.dailyProfit)}</span>
            </div>
            <div class="farm-breakdown-row" style="border-top:1px solid var(--border); padding-top:8px; margin-top:4px;">
              <span class="label" style="font-weight:700; color:var(--accent); font-size:15px;">Monthly Profit (30d)</span>
              <span class="value" style="color:${data.monthlyProfit >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:18px; font-weight:700;">${data.monthlyProfit >= 0 ? '+' : ''}${formatSilver(data.monthlyProfit)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

// ═══════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════

let currentTool = 'flipper';

function selectTool(tool, el) {
  document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  currentTool = tool;

  // Toggle sidebar panels
  document.getElementById('flipperSidebar').style.display = tool === 'flipper' ? '' : 'none';
  document.getElementById('farmingSidebar').style.display = tool === 'farming' ? '' : 'none';

  // Toggle content panels
  document.getElementById('flipperContent').style.display = tool === 'flipper' ? '' : 'none';
  document.getElementById('farmingContent').style.display = tool === 'farming' ? '' : 'none';

  // Initialize farming sidebar on first switch
  if (tool === 'farming' && !document.getElementById('farmProduct').options.length) {
    populateFarmProducts();
  }
}

function toggleSettings() {
  const dropdown = document.getElementById('settingsDropdown');
  const btn = document.getElementById('gearBtn');
  const isOpen = dropdown.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
}

function setServer(server, el) {
  currentServer = server;
  priceCache = {};
  document.querySelectorAll('.server-option').forEach(opt => opt.classList.remove('active'));
  el.classList.add('active');
}

// Close settings dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('settingsDropdown');
  const btn = document.getElementById('gearBtn');
  if (dropdown && !dropdown.contains(e.target) && !btn.contains(e.target)) {
    dropdown.classList.remove('open');
    btn.classList.remove('active');
  }
});

function formatSilver(amount) {
  if (amount >= 1000000) return (amount / 1000000).toFixed(1) + 'M';
  if (amount >= 1000) return (amount / 1000).toFixed(1) + 'K';
  return amount.toLocaleString();
}

function setStatus(text) {
  document.getElementById('statusText').innerHTML = text;
}

function showProgress(show) {
  document.getElementById('progressContainer').classList.toggle('active', show);
  if (!show) {
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = '0%';
  }
}

function updateProgress(pct) {
  const percent = Math.round(pct * 100);
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressText').textContent = percent + '%';
}

function getRelativeTime(dateStr) {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

let ageInterval = null;

function startAgeTimer() {
  if (ageInterval) clearInterval(ageInterval);
  const ageEl = document.getElementById('dataAge');
  ageEl.style.display = 'flex';

  function update() {
    if (!lastScanTime) return;
    const diffMs = Date.now() - lastScanTime;
    const diffMin = Math.floor(diffMs / 60000);
    const dot = document.getElementById('ageDot');
    const text = document.getElementById('ageText');

    if (diffMin < 1) {
      text.textContent = 'Updated just now';
      dot.className = 'dot';
    } else if (diffMin < 5) {
      text.textContent = `Updated ${diffMin}m ago`;
      dot.className = 'dot';
    } else if (diffMin < 15) {
      text.textContent = `Updated ${diffMin}m ago`;
      dot.className = 'dot stale';
    } else {
      text.textContent = `Updated ${diffMin}m ago (stale)`;
      dot.className = 'dot old';
    }
  }

  update();
  ageInterval = setInterval(update, 30000);
}
