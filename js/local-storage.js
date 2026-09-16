(function (root) {
    "use strict";

    const downloads = new Map();
    let queue = Promise.resolve();

    function segment(value, fallback) {
        let clean = String(value == null ? "" : value)
            .normalize("NFKC")
            .replace(/[\\/\u0000-\u001f\u007f:*?"<>|]/g, "_")
            .replace(/^\.+|\.+$/g, "")
            .replace(/\s+/g, " ")
            .trim();
        if (!clean || clean === "." || clean === "..") clean = fallback;
        return clean.slice(0, 120).replace(/^\.+|\.+$/g, "").trim() || fallback;
    }

    function firstUrl(value) {
        if (typeof value === "string") return value;
        if (!value || typeof value !== "object") return "";
        const list = value.urlList || value.url_list || value.urls;
        if (Array.isArray(list)) return list.find(url => typeof url === "string") || "";
        return firstUrl(value.url || value.uri);
    }

    function imageUrl(node) {
        const candidates = node && node.image_versions2 && node.image_versions2.candidates;
        const resources = node && node.display_resources;
        return (Array.isArray(candidates) && firstUrl(candidates[0])) ||
            (Array.isArray(resources) && resources.length && firstUrl(resources[resources.length - 1] && (resources[resources.length - 1].src || resources[resources.length - 1]))) ||
            firstUrl(node && (node.display_url || node.display_uri || node.image_url));
    }

    function videoUrl(node) {
        const versions = node && node.video_versions;
        return (Array.isArray(versions) && firstUrl(versions[0])) || firstUrl(node && node.video_url);
    }

    function extension(url, fallback) {
        try {
            const match = new URL(url).pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
            if (match && /^(?:jpe?g|png|webp|gif|mp4|mov|webm)$/i.test(match[1])) {
                return match[1].toLowerCase().replace("jpeg", "jpg");
            }
        } catch (_) { /* use the media default */ }
        return fallback;
    }

    function platformOf(row, data) {
        const source = String((row && row.source_platform) || data.source_platform || "").toLowerCase();
        if (source.includes("tiktok")) return "tiktok";
        if (source.includes("instagram")) return "instagram";
        if (data.aweme_id || data.awemeId || (data.author && (data.author.uniqueId || data.author.unique_id))) return "tiktok";
        return "instagram";
    }

    function isStory(row, data) {
        const kind = String(data._tt_type || data.__tidal_content_type || data.content_type || data.product_type || "").toLowerCase();
        return kind === "story" || kind === "stories" || Boolean(data.expiring_at) ||
            String((row && row.module_name) || "").toLowerCase() === "stories";
    }

    function plan(row) {
        const data = row && row.data && typeof row.data === "object" ? row.data : (row || {});
        const platform = platformOf(row || {}, data);
        const username = segment(
            data.user && (data.user.username || data.user.unique_id || data.user.uniqueId) ||
            data.owner && data.owner.username ||
            data.author && typeof data.author === "object" && (data.author.uniqueId || data.author.unique_id || data.author.nickname) ||
            typeof data.author === "string" && data.author ||
            data.username,
            "unknown"
        );
        const id = segment(data.pk || data.id || data.aweme_id || data.awemeId || data.code, "unknown");
        const story = platform === "instagram" && isStory(row || {}, data);
        const base = story ? `tidaltales/${username}/${id}` : `tidaltales/${platform}/${username}/${id}`;
        const result = [{ filename: `${base}.json`, type: "metadata", data: data }];

        if (platform === "instagram") {
            const graphChildren = data.edge_sidecar_to_children && data.edge_sidecar_to_children.edges;
            const nodes = Array.isArray(data.carousel_media) && data.carousel_media.length ? data.carousel_media :
                (Array.isArray(graphChildren) && graphChildren.length ? graphChildren.map(edge => edge.node || edge) : [data]);
            nodes.forEach((node, index) => {
                const suffix = nodes.length > 1 ? `_${index + 1}` : "";
                const video = videoUrl(node);
                const image = imageUrl(node);
                if (video) result.push({ filename: `${base}${suffix}.${extension(video, "mp4")}`, type: "video", url: video });
                if (image) result.push({ filename: `${base}${suffix}.${extension(image, "jpg")}`, type: "image", url: image });
                const productType = String(node.product_type || "").toLowerCase();
                if (!video && (node.is_video === true || Number(node.media_type) === 2 || ["GraphVideo", "XIGPolarisVideoMedia"].includes(node.__typename) || ["clips", "reels", "video"].includes(productType))) {
                    result.push({ filename: `${base}${suffix}.mp4`, type: "video", missing: true, error: "Video URL is missing from the captured metadata" });
                } else if (!video && !image) {
                    result.push({ filename: `${base}${suffix}.jpg`, type: "image", missing: true, error: "Media URL is missing from the captured metadata" });
                }
            });
        } else {
            const video = firstUrl(data.video && (data.video.playAddr || data.video.downloadAddr || data.video.play_addr || data.video.download_addr)) ||
                firstUrl(data.playAddr || data.downloadAddr || data.video_url);
            if (video) result.push({ filename: `${base}.${extension(video, "mp4")}`, type: "video", url: video });

            const images = data.imagePost && (data.imagePost.images || data.imagePost.imageList) || data.images;
            if (Array.isArray(images)) {
                images.forEach((image, index) => {
                    const url = firstUrl(image && (image.displayImage || image.imageURL || image.imageUrl || image));
                    if (url) result.push({ filename: `${base}_${index + 1}.${extension(url, "jpg")}`, type: "image", url: url });
                });
            }

            const cover = !video ? "" : firstUrl(data.video && (data.video.cover || data.video.originCover || data.video.dynamicCover));
            if (cover) result.push({ filename: `${base}_cover.${extension(cover, "jpg")}`, type: "image", url: cover });
            if (!video && !(Array.isArray(images) && images.length)) {
                result.push({ filename: `${base}.mp4`, type: "video", missing: true, error: "Video URL is missing from the captured metadata" });
            }
        }
        // TikTok's CDN requires the browsing origin even when the signed URL
        // and session cookies are valid. Use only the origin, never a user's
        // page path/query, and keep it off metadata and other platforms.
        if (platform === "tiktok") {
            for (const task of result) {
                if (task.url) task.headers = [{name: "Referer", value: "https://www.tiktok.com/"}];
            }
        }
        return result;
    }

    function isErrorDocument(item) {
        const mime = String(item && item.mime || "").split(";")[0].trim().toLowerCase();
        return ["text/html", "application/xhtml+xml", "application/json", "text/plain"].includes(mime);
    }

    function exactFilename(download, filename) {
        const actual = String(download && download.filename || "").replace(/\\/g, "/");
        const wanted = filename.replace(/\\/g, "/");
        return actual === wanted || actual.endsWith(`/${wanted}`);
    }

    async function alreadyDownloaded(filename) {
        const matches = await browser.downloads.search({ query: [filename], state: "complete" });
        return matches.some(item => exactFilename(item, filename) && item.exists === true && item.state === "complete" && !isErrorDocument(item));
    }

    function waitForDownload(id, timeoutMs) {
        return new Promise(resolve => {
            let done = false;
            let timer;
            const finish = result => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (browser.downloads.onChanged && browser.downloads.onChanged.removeListener) {
                    browser.downloads.onChanged.removeListener(change);
                }
                resolve(result);
            };
            const change = delta => {
                if (delta.id !== id || !delta.state) return;
                if (delta.state.current === "complete") finish({ status: "complete" });
                if (delta.state.current === "interrupted") finish({ status: "interrupted", error: delta.error && delta.error.current || "Download interrupted" });
            };
            if (browser.downloads.onChanged && browser.downloads.onChanged.addListener) {
                browser.downloads.onChanged.addListener(change);
            }
            timer = setTimeout(() => finish({ status: "timeout", error: "Download did not finish before the timeout" }), timeoutMs);
            browser.downloads.search({ id: id }).then(items => {
                const item = items[0];
                if (item && item.state === "complete") finish({ status: "complete" });
                else if (item && item.state === "interrupted") finish({ status: "interrupted", error: item.error || "Download interrupted" });
            }).catch(() => {});
        });
    }

    async function download(task) {
        let objectUrl = null;
        try {
            if (task.missing) {
                return { filename: task.filename, type: task.type, status: "missing", error: task.error };
            }
            // Metadata is deliberately refreshed: collectors can first see a partial
            // item and enrich that same item after a later response arrives.
            if (task.type !== "metadata" && await alreadyDownloaded(task.filename)) {
                return { filename: task.filename, type: task.type, status: "exists" };
            }
            if (task.type === "metadata") {
                objectUrl = URL.createObjectURL(new Blob([JSON.stringify(task.data, null, 2)], { type: "application/json" }));
            } else {
                let parsed;
                try { parsed = new URL(task.url); } catch (_) { parsed = null; }
                if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
                    throw new Error("Media URL must use HTTP or HTTPS");
                }
            }
            const id = await browser.downloads.download({
                url: objectUrl || task.url,
                filename: task.filename,
                conflictAction: "overwrite",
                saveAs: false,
                ...(task.headers ? {headers: task.headers} : {})
            });
            const terminal = await waitForDownload(id, root.TIDAL_DOWNLOAD_TIMEOUT_MS || 120000);
            if (terminal.status === "timeout" && browser.downloads.cancel) {
                try { await browser.downloads.cancel(id); } catch (_) { /* already terminal */ }
            }
            if (terminal.status === "complete" && task.type !== "metadata") {
                // A completed transfer can still be a CDN error document.
                // Accept binary/unspecified MIME types used by legitimate CDNs.
                const [item] = await browser.downloads.search({id});
                if (isErrorDocument(item)) {
                    terminal.status = "error";
                    terminal.error = `Server returned ${item.mime} instead of media; revisit the post to retry`;
                }
            }
            return Object.assign({ filename: task.filename, type: task.type }, terminal);
        } catch (error) {
            return { filename: task.filename, type: task.type, status: "error", error: error && error.message || String(error) };
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
    }

    function schedule(task) {
        // Never coalesce metadata revisions; the global queue still serializes them.
        if (task.type !== "metadata" && downloads.has(task.filename)) return downloads.get(task.filename);
        const pending = queue.then(() => download(task), () => download(task));
        queue = pending.catch(() => {});
        if (task.type !== "metadata") {
            downloads.set(task.filename, pending);
            pending.finally(() => downloads.delete(task.filename));
        }
        return pending;
    }

    async function save(row) {
        const local_files = await Promise.all(plan(row).map(schedule));
        const ok = local_files.filter(file => file.status === "complete" || file.status === "exists").length;
        let download_status = "failed";
        if (ok === local_files.length) download_status = "complete";
        else if (ok > 0) download_status = "partial";
        return { local_files: local_files, download_status: download_status };
    }

    root.tidalStorage = { save: save, plan: plan };
})(typeof window !== "undefined" ? window : globalThis);
