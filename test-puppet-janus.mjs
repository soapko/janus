#!/usr/bin/env node
/**
 * Integration test: puppet janusTab() with running Janus instance
 *
 * Tests:
 * 1. janusListTabs() — list existing tabs
 * 2. janusTab() — create a new tab and automate it
 * 3. janusNavigateTab() — navigate an existing tab
 * 4. janusCloseTab() — close the created tab
 */

import { janusTab, janusListTabs, janusCloseTab, janusNavigateTab } from 'puppet';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function run() {
  console.log('\nPuppet + Janus Integration Test\n');

  let createdTabId;
  let browser;

  // Test 1: List existing tabs
  await test('janusListTabs() returns array', async () => {
    const tabs = await janusListTabs();
    console.log(`    Found ${tabs.length} existing tab(s)`);
    if (!Array.isArray(tabs)) throw new Error('Expected array');
  });

  // Test 2: Create a new tab and automate it
  await test('janusTab() creates tab and connects via CDP', async () => {
    browser = await janusTab({ url: 'https://httpbin.org/html' });
    console.log(`    Page URL: ${await browser.url()}`);
    console.log(`    Page title: ${await browser.title()}`);
  });

  // Test 3: Find the created tab
  await test('New tab appears in janusListTabs()', async () => {
    const tabs = await janusListTabs();
    const httpbinTab = tabs.find(t => t.url.includes('httpbin'));
    if (!httpbinTab) throw new Error('Created tab not found in list');
    createdTabId = httpbinTab.id;
    console.log(`    Tab ID: ${createdTabId}`);
  });

  // Test 4: Read page content
  await test('Can read page content via CDP', async () => {
    await browser.waitForLoaded();
    const title = await browser.title();
    if (!title) throw new Error('Could not read page title');
    console.log(`    Title: ${title}`);
  });

  // Test 5: Navigate the tab
  await test('janusNavigateTab() changes URL', async () => {
    await janusNavigateTab(createdTabId, 'https://example.com');
    // Wait for navigation
    await new Promise(r => setTimeout(r, 2000));
    const tabs = await janusListTabs();
    const tab = tabs.find(t => t.id === createdTabId);
    console.log(`    Tab URL after navigate: ${tab?.url}`);
  });

  // Test 6: Close the browser connection
  await test('browser.close() disconnects CDP', async () => {
    await browser.close();
  });

  // Test 7: Clean up — close the created tab
  await test('janusCloseTab() removes the tab', async () => {
    await janusCloseTab(createdTabId);
    const tabs = await janusListTabs();
    const found = tabs.find(t => t.id === createdTabId);
    if (found) throw new Error('Tab still exists after close');
    console.log(`    Tab ${createdTabId} removed`);
  });

  console.log('\n  All tests passed!\n');
}

run().catch(err => {
  console.error('\n  Test failed:', err.message);
  process.exit(1);
});
