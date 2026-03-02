#!/usr/bin/env node
/**
 * Super basic test: open example.com in Janus, click the "More information..." link
 */
import { janusTab, janusListTabs, janusCloseTab } from '/Users/karl/Documents/_Projects/puppet/dist/index.js';

async function run() {
  console.log('1. Opening example.com in Janus...');
  const browser = await janusTab({ url: 'https://example.com' });

  console.log('2. Page loaded:', await browser.title());

  console.log('3. Clicking "More information..." link...');
  await browser.page.locator('a:has-text("More information")').click();

  // Wait for navigation
  await browser.page.waitForLoadState('domcontentloaded');

  const newUrl = browser.page.url();
  const newTitle = await browser.title();
  console.log('4. Navigated to:', newUrl);
  console.log('   Title:', newTitle);

  // Clean up
  const tabs = await janusListTabs();
  const ourTab = tabs.find(t => t.url.includes('iana.org') || t.url.includes('example.com'));
  if (ourTab) {
    await janusCloseTab(ourTab.id);
    console.log('5. Cleaned up tab');
  }

  await browser.close();
  console.log('\nDone! Page opened, link clicked, navigation confirmed.');
}

run().catch(err => {
  console.error('Failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
