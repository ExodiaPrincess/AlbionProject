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
let favorites = loadFavorites();
let consumed = new Set();     // Flips consumed this session
let scanning = false;
let lastScanTime = null;

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  buildCategoryCheckboxes();
  document.getElementById('showFavoritesOnly').addEventListener('change', applyFiltersAndRender);
  document.getElementById('multiRouteToggle').addEventListener('change', (e) => {
    document.getElementById('singleRouteControls').style.display = e.target.checked ? 'none' : 'block';
  });
  document.getElementById('enchantFlipToggle').addEventListener('change', (e) => {
    document.getElementById('enchantFlipControls').style.display = e.target.checked ? 'block' : 'none';
  });
});

function buildCategoryCheckboxes() {
  const grid = document.getElementById('categoryGrid');
  const categories = getCategoryNames();
  grid.innerHTML = categories.map(cat => {
    const id = `cat_${cat.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const count = getItemsByCategories([cat]).length;
    return `<label><input type="checkbox" id="${id}" value="${cat}" checked> ${cat} <span style="color:var(--text-muted); font-size:11px;">(${count})</span></label>`;
  }).join('');
}

function selectAllCategories() {
  document.querySelectorAll('#categoryGrid input').forEach(cb => cb.checked = true);
}

function deselectAllCategories() {
  document.querySelectorAll('#categoryGrid input').forEach(cb => cb.checked = false);
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

function calculateFlips(priceData, originCity, destCity, applyTax) {
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
    const taxRate = applyTax ? 0.08 : 0;
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

function calculateEnchantFlips(priceData, city, matCount, applyTax) {
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

      const taxRate = applyTax ? 0.08 : 0;
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
  const applyTax = document.getElementById('applyTax').checked;

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
          const flips = calculateFlips(priceData, origin, dest, applyTax);
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

      allFlips = calculateFlips(priceData, originCity, destCity, applyTax);
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
    const enchantCity = document.getElementById('enchantCity').value;
    const matCount = parseInt(document.getElementById('enchantMatCount').value) || 48;
    const applyTax = document.getElementById('applyTax').checked;

    // Get enchantable base items from selected categories
    const enchantableItems = getEnchantableItems(selectedCategories);

    if (enchantableItems.length > 0) {
      setStatus(`Scanning ${enchantableItems.length} items for enchant upgrades in ${enchantCity}...`);
      showProgress(true);

      try {
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

        const enchantPriceData = await fetchAllPrices(enchantItemIds, [enchantCity], (pct) => {
          updateProgress(pct);
        });

        const enchantFlips = calculateEnchantFlips(enchantPriceData, enchantCity, matCount, applyTax);
        allFlips.push(...enchantFlips);
      } catch (err) {
        console.warn('Enchant flip scan error:', err);
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
  const showFavsOnly = document.getElementById('showFavoritesOnly').checked;

  let filtered = currentResults.filter(flip => {
    if (flip.profit < minProfit) return false;
    if (flip.margin < minMargin) return false;
    if (tierFilter !== 'all' && flip.tier !== parseInt(tierFilter)) return false;
    if (enchantFilter !== 'all' && flip.enchantment !== parseInt(enchantFilter)) return false;
    if (showFavsOnly && !favorites.has(flip.itemId)) return false;
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
    case 'buyPrice':
      results.sort((a, b) => a.buyPrice - b.buyPrice);
      break;
    case 'sellPrice':
      results.sort((a, b) => b.sellPrice - a.sellPrice);
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
          <th></th>
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
    const isFav = favorites.has(flip.itemId);
    const buyAge = getRelativeTime(flip.buyDate);
    const sellAge = getRelativeTime(flip.sellDate);
    const oldestAge = buyAge.includes('day') || sellAge.includes('day') ? 'stale' : '';

    // Type column content
    let typeCol = '';
    if (flip.isEnchantFlip) {
      const matLabels = flip.matDetails.map(m => `${m.count}x ${m.type} (${formatSilver(m.totalCost)})`).join(' + ');
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
        <td>
          <button class="fav-btn ${isFav ? 'active' : ''}" onclick="toggleFavorite('${flip.itemId}', this)" title="Toggle favorite">
            ${isFav ? '&#9733;' : '&#9734;'}
          </button>
        </td>
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
        <td><button class="consume-btn" onclick="consumeFlip('${flip.itemId}', ${flip.quality}, '${flip.originCity}', '${consumeDest}')">Done</button></td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  return html;
}

// ═══════════════════════════════════════════════════════════
// FAVORITES
// ═══════════════════════════════════════════════════════════

function loadFavorites() {
  try {
    const stored = localStorage.getItem('albion_flipper_favorites');
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  localStorage.setItem('albion_flipper_favorites', JSON.stringify([...favorites]));
}

function consumeFlip(itemId, quality, origin, dest) {
  const key = `${itemId}__${quality}__${origin}__${dest}`;
  consumed.add(key);
  applyFiltersAndRender();
}

function getItemIconUrl(itemId) {
  return `https://render.albiononline.com/v1/item/${itemId}.png?size=64`;
}

function toggleFavorite(itemId, btn) {
  if (favorites.has(itemId)) {
    favorites.delete(itemId);
    btn.classList.remove('active');
    btn.innerHTML = '&#9734;';
  } else {
    favorites.add(itemId);
    btn.classList.add('active');
    btn.innerHTML = '&#9733;';
  }
  saveFavorites();
}

// ═══════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════

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
