#!/usr/bin/env node
/**
 * Exports your purchasing data from MarginEdge's read-only public API into JSON files:
 * invoices with line items, products, vendors, vendor items with pack sizes, and categories.
 *
 * Run it on your own computer (needs Node.js 18 or newer):
 *
 *   node marginedge-export.mjs                 # last 6 months
 *   node marginedge-export.mjs --months 12     # last 12 months
 *
 * It asks for your MarginEdge API key without showing it on screen, or reads it from the
 * MARGINEDGE_API_KEY environment variable. The key is never saved or printed.
 * Output goes to a new folder named marginedge-export-<today>.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BASE_URL = process.env.MARGINEDGE_BASE_URL || 'https://api.marginedge.com/public'; // override only for testing
const REQUESTS_PER_SECOND = 4;

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const options = { months: 6, out: `marginedge-export-${new Date().toISOString().slice(0, 10)}`, skipPackaging: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--months') options.months = Number(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--skip-packaging') options.skipPackaging = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node marginedge-export.mjs [--months 6] [--out folder] [--skip-packaging]');
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(options.months) || options.months <= 0) {
    console.error('--months must be a positive number');
    process.exit(1);
  }
  return options;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      // Show the question, hide what's typed.
      if (text.includes(question)) rl.output.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------- API client

let apiKey = '';
let lastRequestAt = 0;
let requestCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(path, query = {}) {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + 1000 / REQUESTS_PER_SECOND - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    requestCount++;

    let response;
    try {
      response = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
    } catch (error) {
      if (attempt >= 5) throw new Error(`Network error calling ${path}: ${error.message}`);
      await sleep(2000 * attempt);
      continue;
    }

    if (response.ok) return response.json();

    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
      continue;
    }
    if (response.status === 403) {
      throw new Error('MarginEdge refused the request (403). Check that the API key is correct and has access to your restaurant.');
    }
    const body = await response.text().catch(() => '');
    throw new Error(`MarginEdge returned ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }
}

/** Follows nextPage cursors and returns every item in the named list. */
async function getAll(path, listName, query = {}) {
  const items = [];
  let nextPage;
  do {
    const page = await get(path, { ...query, nextPage });
    items.push(...(page[listName] ?? []));
    nextPage = page.nextPage || undefined;
  } while (nextPage);
  return items;
}

// ---------------------------------------------------------------- export steps

function monthWindows(months) {
  // Month-sized windows, newest last, ending today.
  const windows = [];
  const today = new Date();
  let end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - months);
  while (end > start) {
    const windowStart = new Date(end);
    windowStart.setUTCMonth(windowStart.getUTCMonth() - 1);
    if (windowStart < start) windowStart.setTime(start.getTime());
    windows.unshift({ startDate: windowStart.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) });
    end = new Date(windowStart);
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return windows;
}

async function exportUnit(unit, options, folder) {
  const restaurantUnitId = unit.id;
  const save = (name, data) => writeFile(join(folder, name), JSON.stringify(data, null, 2) + '\n');

  console.log('  categories…');
  const categories = await getAll('/categories', 'categories', { restaurantUnitId });
  await save('categories.json', categories);

  console.log('  products…');
  const products = await getAll('/products', 'products', { restaurantUnitId });
  await save('products.json', products);

  console.log('  vendors…');
  const vendors = await getAll('/vendors', 'vendors', { restaurantUnitId });
  await save('vendors.json', vendors);

  console.log('  vendor items…');
  const vendorItems = [];
  for (const vendor of vendors) {
    const items = await getAll(`/vendors/${encodeURIComponent(vendor.vendorId)}/vendorItems`, 'vendorItems', { restaurantUnitId });
    vendorItems.push(...items);
  }
  if (!options.skipPackaging) {
    console.log(`  pack sizes for ${vendorItems.length} vendor items…`);
    let done = 0;
    for (const item of vendorItems) {
      if (!item.vendorItemCode) continue;
      try {
        item.packagings = await getAll(
          `/vendors/${encodeURIComponent(item.vendorId)}/vendorItems/${encodeURIComponent(item.vendorItemCode)}/packaging`,
          'packagings',
          { restaurantUnitId },
        );
      } catch (error) {
        item.packagingsError = error.message;
      }
      if (++done % 50 === 0) console.log(`    ${done} / ${vendorItems.length}`);
    }
  }
  await save('vendor-items.json', vendorItems);

  console.log(`  invoices for the last ${options.months} months…`);
  const orders = [];
  for (const window of monthWindows(options.months)) {
    const summaries = await getAll('/orders', 'orders', { restaurantUnitId, ...window });
    console.log(`    ${window.startDate} to ${window.endDate}: ${summaries.length} invoices`);
    for (const summary of summaries) {
      try {
        orders.push(await get(`/orders/${encodeURIComponent(summary.orderId)}`, { restaurantUnitId }));
      } catch (error) {
        orders.push({ ...summary, detailError: error.message });
      }
    }
  }
  await save('invoices.json', orders);

  const lineCount = orders.reduce((sum, order) => sum + (order.lineItems?.length ?? 0), 0);
  return { categories: categories.length, products: products.length, vendors: vendors.length, vendorItems: vendorItems.length, invoices: orders.length, invoiceLines: lineCount };
}

// ---------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));

  apiKey = process.env.MARGINEDGE_API_KEY?.trim() || (await askHidden('MarginEdge API key (hidden): '));
  if (!apiKey) {
    console.error('No API key given.');
    process.exit(1);
  }

  console.log('Connecting to MarginEdge…');
  const { restaurants = [] } = await get('/restaurantUnits');
  if (restaurants.length === 0) {
    console.error('This key has no restaurants attached.');
    process.exit(1);
  }

  await mkdir(options.out, { recursive: true });
  await writeFile(join(options.out, 'restaurant-units.json'), JSON.stringify(restaurants, null, 2) + '\n');

  const summary = [];
  for (const unit of restaurants) {
    console.log(`\n${unit.name} (unit ${unit.id})`);
    const folder = join(options.out, `unit-${unit.id}`);
    await mkdir(folder, { recursive: true });
    summary.push({ restaurant: unit.name, unitId: unit.id, ...(await exportUnit(unit, options, folder)) });
  }

  const manifest = { exportedAt: new Date().toISOString(), months: options.months, requests: requestCount, restaurants: summary };
  await writeFile(join(options.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log('\nDone.');
  console.table(summary);
  console.log(`Files are in: ${options.out}`);
}

main().catch((error) => {
  console.error(`\nExport stopped: ${error.message}`);
  process.exit(1);
});
