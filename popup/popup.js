const CSV_HEADERS = [
    'Database ID', 'Platform', 'Content Type', 'Item ID', 'Collected At', 'Posted At',
    'Username', 'User ID', 'Caption', 'Permalink', 'Media Type', 'Duration (s)',
    'Expiration', 'Is Verified', 'Likes', 'Comments', 'Shares', 'Plays',
    'Download Status', 'JSON Paths', 'Image Paths', 'Video Paths', 'Other Local Paths',
    'File Statuses', 'Download Errors', 'Legacy Expected JSON Path',
    'Legacy Expected Image Path', 'Legacy Expected Video Path', 'Source Page URL',
    'Source Request URL', 'Raw Data JSON'
];

function valueAt(object, paths, fallback = '') {
    for (const path of paths) {
        let value = object;
        for (const key of path.split('.')) value = value != null ? value[key] : undefined;
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
}

function asText(value) {
    if (value == null) return '';
    if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
}

function isoDate(value, milliseconds = false) {
    if (value == null || value === '') return '';
    if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const date = new Date(milliseconds || numeric > 100000000000 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function platformLabel(item) {
    if (item.source_platform === 'tiktok.com') return 'TikTok';
    if (['instagram.com', 'instagram-stories'].includes(item.source_platform)) return 'Instagram';
    return item.source_platform || 'Unknown';
}

function permalink(item, type) {
    const data = item.data || {};
    const explicit = valueAt(data, ['permalink', 'url', 'tiktok_url']);
    if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) return explicit;
    if (item.source_platform === 'tiktok.com') {
        const username = valueAt(data, ['author.uniqueId', 'author.unique_id', 'username']);
        const id = valueAt(data, ['id', 'aweme_id', 'awemeId'], item.item_id);
        return username && id ? `https://www.tiktok.com/@${username}/video/${id}` : '';
    }
    if (item.source_platform === 'instagram.com' && ['Post', 'Reel'].includes(type)) {
        const code = valueAt(data, ['code', 'shortcode']);
        if (code) return `https://www.instagram.com/${type === 'Reel' ? 'reel' : 'p'}/${code}/`;
    }
    return '';
}

function contentType(item) {
    const data = item.data || {};
    const explicit = asText(data._tt_type).toLowerCase();
    if (explicit.includes('story')) return 'Story';
    if (explicit.includes('reel')) return 'Reel';
    if (explicit.includes('tiktok') || explicit.includes('video')) {
        return item.source_platform === 'tiktok.com' ? 'TikTok video' : 'Reel';
    }
    if (explicit.includes('post') || explicit.includes('photo') || explicit.includes('carousel')) {
        return item.source_platform === 'tiktok.com' ? 'TikTok post' : 'Post';
    }
    if (item.source_platform === 'instagram-stories' || data.expiring_at || data.story_bloks_stickers) return 'Story';
    if (item.source_platform === 'tiktok.com') return 'TikTok video';
    const pageUrl = `${item.source_platform_url || ''} ${item.source_url || ''}`;
    if (/\/reels?\//i.test(pageUrl) || data.product_type === 'clips') return 'Reel';
    if (item.source_platform === 'instagram.com') return 'Post';
    return 'Unknown';
}

function classifyFile(file) {
    const type = asText(file && file.type).toLowerCase();
    const filename = asText(file && file.filename).toLowerCase();
    if (type.includes('json') || filename.endsWith('.json')) return 'json';
    if (type.includes('image') || /\.(jpe?g|png|webp|gif|avif)$/.test(filename)) return 'image';
    if (type.includes('video') || /\.(mp4|webm|mov|m4v)$/.test(filename)) return 'video';
    return 'other';
}

function fileDetails(item) {
    const files = Array.isArray(item.local_files) ? item.local_files.filter(file => file && typeof file === 'object') : [];
    const paths = {json: [], image: [], video: [], other: []};
    const statuses = [];
    const errors = [];
    for (const file of files) {
        const filename = asText(file.filename);
        const status = asText(file.status).toLowerCase();
        // Planned filenames only become local paths after Firefox confirms the
        // download, or an exact existing download is found.
        if (filename && ['complete', 'completed', 'downloaded', 'exists', 'existing'].includes(status)) {
            paths[classifyFile(file)].push(filename);
        }
        if (file.status) statuses.push(`${filename || classifyFile(file)}: ${asText(file.status)}`);
        if (file.error) errors.push(`${filename || classifyFile(file)}: ${asText(file.error)}`);
    }
    return {files, paths, statuses, errors};
}

function legacyExpectedPaths(item, type) {
    if (type !== 'Story' || Array.isArray(item.local_files)) return {};
    const data = item.data || {};
    const username = valueAt(data, ['user.username', 'username']);
    const id = valueAt(data, ['pk', 'id'], item.item_id);
    if (!username || !id) return {};
    const base = `tidaltales/${username}/${id}`;
    return {
        json: `${base}.json`,
        image: data.image_versions2 ? `${base}.jpg` : '',
        video: Array.isArray(data.video_versions) && data.video_versions.length ? `${base}.mp4` : ''
    };
}

function downloadStatus(item, details, hasLegacyPaths) {
    if (item.download_status != null && item.download_status !== '') return asText(item.download_status);
    if (details.errors.length) return 'failed';
    if (details.files.length) {
        const statuses = details.files.map(file => asText(file.status).toLowerCase());
        if (statuses.some(status => ['failed', 'error'].includes(status))) return 'failed';
        if (statuses.some(status => ['pending', 'started'].includes(status))) return 'pending';
        return statuses.every(status => ['complete', 'completed', 'downloaded', 'exists', 'existing', 'skipped'].includes(status))
            ? 'complete' : 'recorded';
    }
    return hasLegacyPaths ? 'unknown (legacy paths unverified)' : 'not recorded';
}

function toExportRow(item) {
    const data = item.data || {};
    const type = contentType(item);
    const details = fileDetails(item);
    const legacy = legacyExpectedPaths(item, type);
    return {
        'Database ID': item.id,
        'Platform': platformLabel(item),
        'Content Type': type,
        'Item ID': valueAt(data, ['pk', 'id', 'code'], item.item_id),
        'Collected At': isoDate(item.timestamp_collected, true),
        'Posted At': isoDate(valueAt(data, ['taken_at', 'taken_at_timestamp', 'createTime', 'create_time', 'unix_timestamp', 'timestamp'])),
        'Username': valueAt(data, ['user.username', 'owner.username', 'author.uniqueId', 'author.username', 'username', 'author']),
        'User ID': valueAt(data, ['user.pk', 'user.id', 'owner.id', 'author.id', 'authorId', 'author_id']),
        'Caption': asText(valueAt(data, ['caption.text', 'edge_media_to_caption.edges.0.node.text', 'caption', 'desc', 'body'])),
        'Permalink': permalink(item, type),
        'Media Type': asText(valueAt(data, ['media_type', '__typename', 'product_type', 'video.format'])),
        'Duration (s)': valueAt(data, ['video_duration', 'video.duration', 'duration']),
        'Expiration': isoDate(valueAt(data, ['expiring_at'])),
        'Is Verified': valueAt(data, ['user.is_verified', 'owner.is_verified', 'author.verified', 'verified']),
        'Likes': valueAt(data, ['like_count', 'edge_media_preview_like.count', 'edge_liked_by.count', 'stats.diggCount', 'likes', 'num_likes']),
        'Comments': valueAt(data, ['comment_count', 'edge_media_preview_comment.count', 'edge_media_to_comment.count', 'stats.commentCount', 'comments', 'num_comments']),
        'Shares': valueAt(data, ['stats.shareCount', 'share_count', 'shares']),
        'Plays': valueAt(data, ['play_count', 'view_count', 'video_view_count', 'stats.playCount', 'plays']),
        'Download Status': downloadStatus(item, details, Boolean(legacy.json || legacy.image || legacy.video)),
        'JSON Paths': details.paths.json.join('; '),
        'Image Paths': details.paths.image.join('; '),
        'Video Paths': details.paths.video.join('; '),
        'Other Local Paths': details.paths.other.join('; '),
        'File Statuses': details.statuses.join('; '),
        'Download Errors': [...details.errors, ...(item.download_error ? [asText(item.download_error)] : [])].join('; '),
        'Legacy Expected JSON Path': legacy.json || '',
        'Legacy Expected Image Path': legacy.image || '',
        'Legacy Expected Video Path': legacy.video || '',
        'Source Page URL': item.source_platform_url || '',
        'Source Request URL': item.source_url || '',
        'Raw Data JSON': asText(data)
    };
}

function escapeCSV(value) {
    let string = asText(value);
    // Prevent spreadsheet applications from treating collected text as a formula.
    if (/^[\t\r ]*[=+\-@]/.test(string)) string = `'${string}`;
    return `"${string.replace(/"/g, '""')}"`;
}

function setMessage(message, isError = false) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.classList.toggle('error', isError);
    status.hidden = !message;
}

async function getItems() {
    const background = browser.extension.getBackgroundPage();
    if (!background || !background.db || !background.db.items) {
        throw new Error('The local collection database is unavailable. Reload the extension and try again.');
    }
    return background.db.items.toArray();
}

function summarizeItems(items) {
    const counts = {stories: 0, posts: 0, reels: 0, tiktok: 0};
    const downloads = {complete: 0, pending: 0, issues: 0, unknown: 0};
    for (const item of items) {
        const type = contentType(item);
        const key = item.source_platform === 'tiktok.com' ? 'tiktok' :
            {Story: 'stories', Post: 'posts', Reel: 'reels'}[type];
        if (key) counts[key]++;
        const state = asText(item.download_status).toLowerCase();
        if (state === 'complete') downloads.complete++;
        else if (state === 'pending') downloads.pending++;
        else if (['failed', 'partial', 'error'].includes(state)) downloads.issues++;
        else downloads.unknown++;
    }
    return {counts, downloads, total: items.length};
}

let captureSettings = null;
let savingSettings = false;
let exporting = false;

function renderCaptureSettings(settings) {
    captureSettings = settings;
    const active = Object.values(settings.modules).filter(Boolean).length;
    const collecting = !settings.paused && active > 0;
    document.getElementById('capture-state').textContent = settings.paused ? 'Capture paused' :
        active === 0 ? 'All modules off' : 'Capture on';
    document.getElementById('state-dot').classList.toggle('active', collecting);
    const pause = document.getElementById('pause-capture');
    pause.textContent = settings.paused ? 'Resume capture' : 'Pause all';
    pause.disabled = savingSettings || (!settings.paused && active === 0);
    document.getElementById('capture-hint').textContent = settings.paused ?
        'No new items are collected. Queued downloads still finish.' : active === 0 ?
        'Turn on a module to start collecting as you browse.' :
        'Choose what to collect. Changes save automatically.';
    for (const [key, enabled] of Object.entries(settings.modules)) {
        const input = document.getElementById(`capture-${key}`);
        if (!input) continue;
        input.checked = enabled;
        input.disabled = savingSettings;
    }
}

async function saveCaptureSettings(patch) {
    if (savingSettings || !captureSettings) return;
    savingSettings = true;
    renderCaptureSettings(captureSettings);
    try {
        const background = browser.extension.getBackgroundPage();
        captureSettings = await background.zeeschuimer.setCaptureSettings(patch);
        setMessage('');
    } catch (error) {
        setMessage(error.message || 'Could not save capture settings. Please try again.', true);
    } finally {
        savingSettings = false;
        renderCaptureSettings(captureSettings);
    }
}

async function updateStats() {
    try {
        const background = browser.extension.getBackgroundPage();
        const [items, settings] = await Promise.all([
            getItems(), background.zeeschuimer.getCaptureSettings()
        ]);
        // A polling response must not overwrite a toggle currently being saved.
        if (!savingSettings) renderCaptureSettings(settings);
        const {counts, downloads, total} = summarizeItems(items);
        for (const [key, count] of Object.entries(counts)) {
            document.getElementById(`count-${key}`).textContent = new Intl.NumberFormat().format(count);
        }
        document.getElementById('export-csv').disabled = total === 0 || exporting;
        document.getElementById('clear-data').disabled = total === 0;
        document.getElementById('collection-total').textContent = `${new Intl.NumberFormat().format(total)} records`;
        document.getElementById('download-total').textContent = total ?
            `${downloads.complete} complete · ${downloads.pending} pending` +
            (downloads.unknown ? ` · ${downloads.unknown} unverified` : '') :
            'Nothing collected yet. Browse a supported site to begin.';
        const issues = document.getElementById('download-issues');
        issues.hidden = !downloads.issues;
        issues.textContent = `${downloads.issues} record${downloads.issues === 1 ? ' needs' : 's need'} attention. Export CSV for download errors.`;
    } catch (error) {
        console.error('Could not load collection statistics', error);
        setMessage(error.message || 'Could not load collection statistics.', true);
    }
}

async function clearDatabase() {
    if (!window.confirm('Clear all collected metadata? Downloaded media files will remain on disk.')) return;
    const button = document.getElementById('clear-data');
    button.disabled = true;
    try {
        const background = browser.extension.getBackgroundPage();
        if (background.zeeschuimer && typeof background.zeeschuimer.enqueue === 'function') {
            await background.zeeschuimer.enqueue(() => background.db.items.clear());
        } else {
            await background.db.items.clear();
        }
        await refreshStats();
        setMessage('Collected metadata cleared. Downloaded files were not removed.');
    } catch (error) {
        console.error('Could not clear collection data', error);
        setMessage(error.message || 'Could not clear collection data.', true);
    } finally {
        button.disabled = false;
    }
}

async function exportDatabaseToCSV() {
    if (exporting) return;
    exporting = true;
    const button = document.getElementById('export-csv');
    button.disabled = true;
    try {
        const items = await getItems();
        if (!items.length) throw new Error('There are no collected records to export.');
        const rows = items.map(toExportRow);
        const csv = [
            CSV_HEADERS.map(escapeCSV).join(','),
            ...rows.map(row => CSV_HEADERS.map(header => escapeCSV(row[header])).join(','))
        ].join('\r\n');
        const timestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\..*$/, '');
        const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], {type: 'text/csv;charset=utf-8'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = `tidaltales_export_${timestamp}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(`Exported ${items.length} record${items.length === 1 ? '' : 's'}.`);
    } catch (error) {
        console.error('Could not export collection data', error);
        setMessage(error.message || 'Could not export collection data.', true);
    } finally {
        exporting = false;
        await refreshStats();
    }
}

let statsUpdate = null;
function refreshStats() {
    if (!statsUpdate) statsUpdate = updateStats().finally(() => { statsUpdate = null; });
    return statsUpdate;
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const manifest = browser.runtime.getManifest();
        document.getElementById('version').textContent = `Version ${manifest.version}`;
    } catch (error) {
        console.error('Could not read extension version', error);
    }
    document.getElementById('clear-data').addEventListener('click', clearDatabase);
    document.getElementById('export-csv').addEventListener('click', exportDatabaseToCSV);
    document.getElementById('pause-capture').addEventListener('click', () => {
        if (captureSettings) saveCaptureSettings({paused: !captureSettings.paused});
    });
    for (const input of document.querySelectorAll('[data-module]')) {
        input.addEventListener('change', () => saveCaptureSettings({modules: {[input.dataset.module]: input.checked}}));
    }
    await refreshStats();
    const timer = window.setInterval(refreshStats, 3000);
    window.addEventListener('unload', () => window.clearInterval(timer), {once: true});
});
