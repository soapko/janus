const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  // Connect to the main Electron app
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const mainPage = context.pages()[0];

  console.log('Connected to Janus app');

  // Control the webview through the main page's webview element
  // The webview tag has methods like: src, getURL, getTitle, executeJavaScript, capturePage

  // Navigate to a URL
  await mainPage.evaluate((url) => {
    const webview = document.getElementById('browser');
    webview.src = url;
  }, 'https://example.com');

  console.log('Navigating to example.com...');

  // Wait for navigation
  await mainPage.evaluate(() => {
    return new Promise((resolve) => {
      const webview = document.getElementById('browser');
      webview.addEventListener('did-finish-load', resolve, { once: true });
    });
  });

  console.log('Navigation complete');

  // Get webview URL
  const url = await mainPage.evaluate(() => {
    return document.getElementById('browser').getURL();
  });
  console.log(`Current URL: ${url}`);

  // Get webview title
  const title = await mainPage.evaluate(() => {
    return document.getElementById('browser').getTitle();
  });
  console.log(`Page title: ${title}`);

  // Execute JavaScript inside the webview
  const h1Text = await mainPage.evaluate(() => {
    const webview = document.getElementById('browser');
    return webview.executeJavaScript('document.querySelector("h1")?.textContent || "No H1 found"');
  });
  console.log(`H1 text: ${h1Text}`);

  // Get all links
  const links = await mainPage.evaluate(() => {
    const webview = document.getElementById('browser');
    return webview.executeJavaScript(`
      Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim(),
        href: a.href
      }))
    `);
  });
  console.log(`Found ${links.length} links`);

  // Click an element (example)
  await mainPage.evaluate(() => {
    const webview = document.getElementById('browser');
    return webview.executeJavaScript('document.querySelector("a")?.click()');
  });

  // Wait a moment for potential navigation
  await new Promise(r => setTimeout(r, 1000));

  // Get updated URL after click
  const newUrl = await mainPage.evaluate(() => {
    return document.getElementById('browser').getURL();
  });
  console.log(`URL after click: ${newUrl}`);

  // Take screenshot of webview
  const screenshot = await mainPage.evaluate(() => {
    const webview = document.getElementById('browser');
    return webview.capturePage().then(img => img.toDataURL());
  });

  // Save screenshot
  const base64Data = screenshot.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync('screenshot.png', base64Data, 'base64');
  console.log('Screenshot saved to screenshot.png');

  // Evaluate complex scripts
  const pageInfo = await mainPage.evaluate(() => {
    const webview = document.getElementById('browser');
    return webview.executeJavaScript(`({
      title: document.title,
      url: window.location.href,
      paragraphs: document.querySelectorAll('p').length,
      bodyText: document.body.innerText.substring(0, 200)
    })`);
  });
  console.log('\nPage info:', pageInfo);

  console.log('\nDone! Playwright automation working.');
}

main().catch(console.error);
