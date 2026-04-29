const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline-sync');
const cliProgress = require('cli-progress');

// Configuration
const LINKS_FILE = 'links.json';
const COMPLETED_FILE = 'completed_links.json';
const FAILED_FILE = 'failed_links.json';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

async function loadJson(filePath) {
    if (await fs.pathExists(filePath)) {
        return fs.readJson(filePath);
    }
    return [];
}

async function saveJson(filePath, data) {
    await fs.writeJson(filePath, data, { spaces: 4 });
}

async function downloadFile(url, destination, description) {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 60000
        });

        const totalLength = response.headers['content-length'];
        await fs.ensureDir(path.dirname(destination));
        const writer = fs.createWriteStream(destination);

        let downloaded = 0;
        const fileBar = new cliProgress.SingleBar({
            format: `${description.padEnd(30)} | {bar} | {percentage}% | {value}/{total} Bytes`,
            hideCursor: true
        }, cliProgress.Presets.shades_classic);

        fileBar.start(parseInt(totalLength) || 0, 0);

        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            fileBar.update(downloaded);
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                fileBar.stop();
                resolve();
            });
            writer.on('error', (err) => {
                fileBar.stop();
                reject(err);
            });
        });
    } catch (err) {
        throw new Error(`Download failed: ${err.message}`);
    }
}

function getShortcode(url) {
    const pathPart = url.split('?')[0].replace(/\/$/, '');
    const parts = pathPart.split('/');
    return parts[parts.length - 1];
}

async function main() {
    console.log('=== Instagram Downloader (JavaScript) ===');
    
    // 1. Credentials
    const username = readline.question('Enter Instagram Username: ');
    const password = readline.question('Enter Instagram Password: ', { hideEchoBack: true });

    // 2. Setup Files
    await fs.ensureDir(DOWNLOAD_DIR);
    const links = await loadJson(LINKS_FILE);
    const completedLinksArr = await loadJson(COMPLETED_FILE);
    const completedLinks = new Set(completedLinksArr);
    const failedLinks = await loadJson(FAILED_FILE);

    const toDownload = links.filter(l => !completedLinks.has(l));

    if (toDownload.length === 0) {
        console.log('No new links to download.');
        return;
    }

    // 3. Browser Setup
    const browser = await chromium.launch({ headless: false }); 
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 4. Login (Strict requirement)
        console.log('Navigating to login page...');
        await page.goto('https://www.instagram.com/accounts/login/');
        await page.fill('input[name="username"]', username);
        await page.fill('input[name="password"]', password);
        await page.click('button[type="submit"]');
        
        console.log('Waiting for login to complete...');
        // Wait until we are definitely logged in (home feed or profile icon present)
        await page.waitForFunction(() => {
            return !window.location.href.includes('login') && 
                   !window.location.href.includes('challenge') &&
                   (document.querySelector('nav') || document.querySelector('[aria-label="Home"]'));
        }, { timeout: 120000 });

        // Double check login status
        const isLoggedIn = await page.evaluate(() => {
            return !!document.querySelector('[aria-label="Home"]') || !!document.querySelector('svg[aria-label="New post"]');
        });

        if (!isLoggedIn) {
            console.error('ERROR: Could not verify login status. Stopping for safety.');
            await browser.close();
            return;
        }
        console.log('Login verified! Starting downloads...');

        // 5. Processing Loop
        const mainBar = new cliProgress.SingleBar({
            format: 'Overall Progress | {bar} | {percentage}% | {value}/{total} Posts',
            hideCursor: false
        }, cliProgress.Presets.shades_classic);

        mainBar.start(links.length, completedLinks.size);

        for (const url of toDownload) {
            const shortcode = getShortcode(url);
            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
                await page.waitForTimeout(3000); // Wait for dynamic content

                // Extract media items specifically from the post content
                const postData = await page.evaluate(() => {
                    const article = document.querySelector('article');
                    if (!article) return { isCarousel: false, items: [] };

                    const items = [];
                    // Check if it's a carousel (dots or next button present)
                    const isCarousel = !!article.querySelector('button[aria-label="Next"]') || 
                                     !!article.querySelector('ul li button'); // Dots are usually buttons in a list

                    if (isCarousel) {
                        // For carousels, we might need to find all items. 
                        // However, IG often lazy-loads them. 
                        // A safer way is to look for all high-res images/videos in the article
                        article.querySelectorAll('video').forEach(v => {
                            if (v.src && !v.src.startsWith('blob:')) items.push({ type: 'video', url: v.src });
                        });
                        article.querySelectorAll('img').forEach(img => {
                            if (img.width > 400 && !img.src.includes('profile')) items.push({ type: 'image', url: img.src });
                        });
                    } else {
                        // Single post
                        const video = article.querySelector('video');
                        if (video && video.src && !video.src.startsWith('blob:')) {
                            items.push({ type: 'video', url: video.src });
                        } else {
                            const img = article.querySelector('div[role="button"] img, div._aagv img');
                            if (img) items.push({ type: 'image', url: img.src });
                        }
                    }

                    // Deduplicate
                    const unique = Array.from(new Map(items.map(i => [i.url, i])).values());
                    return { isCarousel, items: unique };
                });

                if (postData.items.length === 0) {
                    throw new Error('Media not found. Post might be restricted or restricted by region.');
                }

                if (postData.isCarousel && postData.items.length > 1) {
                    // Save in folder only if it's a confirmed carousel
                    const carouselDir = path.join(DOWNLOAD_DIR, `carousel_${shortcode}`);
                    await fs.ensureDir(carouselDir);
                    for (let i = 0; i < postData.items.length; i++) {
                        const item = postData.items[i];
                        const ext = item.type === 'video' ? 'mp4' : 'jpg';
                        const dest = path.join(carouselDir, `${shortcode}_${i + 1}.${ext}`);
                        await downloadFile(item.url, dest, `Carousel Part ${i + 1}/${postData.items.length}`);
                    }
                } else {
                    // Single item (Image or Reel) - Save normally
                    const item = postData.items[0];
                    const ext = item.type === 'video' ? 'mp4' : 'jpg';
                    const dest = path.join(DOWNLOAD_DIR, `${shortcode}.${ext}`);
                    await downloadFile(item.url, dest, `Downloading ${shortcode}`);
                }

                completedLinks.add(url);
                await saveJson(COMPLETED_FILE, Array.from(completedLinks));
            } catch (err) {
                process.stdout.write(`\nError: ${url} -> ${err.message}\n`);
                failedLinks.push({ url, error: err.message, timestamp: new Date().toISOString() });
                await saveJson(FAILED_FILE, failedLinks);
            }
            
            mainBar.update(completedLinks.size);
            await page.waitForTimeout(2000 + Math.random() * 2000); // Varied delay
        }

        mainBar.stop();
        console.log('\nFinished all tasks.');

    } catch (err) {
        console.error('Fatal error in main loop:', err);
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
