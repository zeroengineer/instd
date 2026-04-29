import os
import json
import time
import getpass
import requests
import random
from pathlib import Path
from tqdm import tqdm
import instaloader

# Configuration
LINKS_FILE = "links.json"
COMPLETED_FILE = "completed_links.json"
FAILED_FILE = "failed_links.json"
DOWNLOAD_DIR = Path("downloads")

def load_json(file_path):
    if os.path.exists(file_path):
        with open(file_path, 'r') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []
    return []

def save_json(file_path, data):
    with open(file_path, 'w') as f:
        json.dump(data, f, indent=4)

def download_file(url, destination, description="Downloading"):
    """Downloads a file with a progress bar."""
    try:
        response = requests.get(url, stream=True, timeout=30)
        response.raise_for_status()
        total_size = int(response.headers.get('content-length', 0))
        
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        
        with open(destination, 'wb') as f, tqdm(
            desc=description.ljust(30),
            total=total_size,
            unit='B',
            unit_scale=True,
            unit_divisor=1024,
            leave=False
        ) as bar:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    bar.update(len(chunk))
    except Exception as e:
        raise Exception(f"Download failed: {str(e)}")

def get_shortcode(url):
    """Extracts shortcode from Instagram URL."""
    path = url.split('?')[0].rstrip('/')
    parts = path.split('/')
    return parts[-1]

def main():
    # 1. Setup Directories
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    
    # 2. Authentication
    print("=== Instagram Downloader (Python) ===")
    username = input("Enter Instagram Username: ")
    password = getpass.getpass("Enter Instagram Password: ")
    
    L = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False
    )
    
    try:
        print(f"Logging in as {username}...")
        L.login(username, password)
        print("Login successful!")
    except Exception as e:
        print(f"Login failed: {e}")
        print("If you have 2FA enabled, please use a session file or app password.")
        return

    # 3. Load Links and Progress
    links = load_json(LINKS_FILE)
    completed_links = set(load_json(COMPLETED_FILE))
    failed_links = load_json(FAILED_FILE)
    
    to_download = [l for l in links if l not in completed_links]
    
    if not to_download:
        print("No new links to download.")
        return

    print(f"Total links: {len(links)}")
    print(f"Completed: {len(completed_links)}")
    print(f"To download: {len(to_download)}")

    # 4. Processing Loop
    with tqdm(total=len(links), initial=len(completed_links), desc="Overall Progress") as pbar:
        for url in to_download:
            shortcode = get_shortcode(url)
            try:
                # Fetch post metadata
                post = instaloader.Post.from_shortcode(L.context, shortcode)
                
                # Logic: Only carousels go into folders
                if post.typename == 'GraphSidecar':
                    # Carousel handling
                    carousel_dir = DOWNLOAD_DIR / f"carousel_{shortcode}"
                    carousel_dir.mkdir(exist_ok=True)
                    
                    nodes = list(post.get_sidecar_nodes())
                    for i, node in enumerate(nodes):
                        file_url = node.video_url if node.is_video else node.display_url
                        ext = "mp4" if node.is_video else "jpg"
                        dest = carousel_dir / f"{shortcode}_{i+1}.{ext}"
                        download_file(file_url, dest, description=f"Carousel {i+1}/{len(nodes)}")
                else:
                    # Single post (Reel or Image) - Save directly in downloads
                    file_url = post.video_url if post.is_video else post.display_url
                    ext = "mp4" if post.is_video else "jpg"
                    dest = DOWNLOAD_DIR / f"{shortcode}.{ext}"
                    download_file(file_url, dest, description=f"Post {shortcode}")

                # Mark as completed
                completed_links.add(url)
                save_json(COMPLETED_FILE, list(completed_links))
                
            except Exception as e:
                print(f"\nError: {url} -> {e}")
                if url not in [f['url'] for f in failed_links]:
                    failed_links.append({"url": url, "error": str(e), "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")})
                save_json(FAILED_FILE, failed_links)
            
            pbar.update(1)
            # Random delay to be safe
            time.sleep(random.uniform(2, 5))

    print("\nDownload process finished.")
    print(f"Successfully downloaded: {len(completed_links)}")
    print(f"Failed: {len(failed_links)}")

if __name__ == "__main__":
    main()
