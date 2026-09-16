/* Capture only supported platforms; downloads remain entirely local. */
window.db = new Dexie('zeeschuimer-items');
db.version(1).stores({
    items: '++id, item_id, nav_index, source_platform',
    uploads: '++id', nav: '++id, tab_id, session', settings: 'key'
});

window.zeeschuimer = {
    modules: {}, session: null, tab_url_map: {}, queue: Promise.resolve(), download_jobs: new Map(),
    capture_settings: null, capture_revision: 0, settings_queue: Promise.resolve(),
    capture_defaults: {paused: false, modules: {stories: true, posts: true, reels: true, tiktok: true}},
    register_module(name, domain, callback) {
        this.modules[domain] = {name, callback};
    },
    async init() {
        let loadedCaptureSettings;
        await db.transaction('rw', db.settings, db.nav, db.items, async () => {
            const savedCaptureSettings = await db.settings.get('capture-settings');
            loadedCaptureSettings = this.validate_capture_settings(savedCaptureSettings && savedCaptureSettings.value);
            const session = await db.settings.get('session');
            this.session = (session ? session.value : 0) + 1;
            await db.settings.put({key: 'session', value: this.session});
            await db.nav.clear();
            // A stopped background page loses its in-memory download queue.
            await db.items.toCollection().modify(row => {
                if (row.download_status === 'pending') {
                    row.download_status = 'failed';
                    row.download_error = 'Capture interrupted by browser restart; revisit the item to retry.';
                }
            });
        });
        // Do not expose settings until the initialization transaction commits.
        this.capture_settings = loadedCaptureSettings;
    },
    validate_capture_settings(value) {
        const defaults = this.capture_defaults;
        const saved = value && typeof value === 'object' ? value : {};
        const modules = saved.modules && typeof saved.modules === 'object' ? saved.modules : {};
        return {
            paused: typeof saved.paused === 'boolean' ? saved.paused : defaults.paused,
            modules: Object.fromEntries(Object.entries(defaults.modules).map(([name, enabled]) =>
                [name, typeof modules[name] === 'boolean' ? modules[name] : enabled]))
        };
    },
    capture_settings_snapshot() {
        return {paused: this.capture_settings.paused, modules: {...this.capture_settings.modules}};
    },
    async getCaptureSettings() {
        await this.ready;
        return this.capture_settings_snapshot();
    },
    async setCaptureSettings(patch) {
        await this.ready;
        const update = async () => {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Capture settings must be an object.');
            if ('paused' in patch && typeof patch.paused !== 'boolean') throw new TypeError('paused must be a boolean.');
            if ('modules' in patch && (!patch.modules || typeof patch.modules !== 'object' || Array.isArray(patch.modules))) {
                throw new TypeError('modules must be an object.');
            }
            const modulePatch = patch.modules || {};
            for (const [name, enabled] of Object.entries(modulePatch)) {
                if (!Object.prototype.hasOwnProperty.call(this.capture_defaults.modules, name) || typeof enabled !== 'boolean') {
                    throw new TypeError(`Invalid capture module setting: ${name}`);
                }
            }
            const next = {paused: 'paused' in patch ? patch.paused : this.capture_settings.paused,
                modules: {...this.capture_settings.modules, ...modulePatch}};
            // Keep the working settings unchanged if persistence fails.
            await db.settings.put({key: 'capture-settings', value: next});
            this.capture_settings = next;
            this.capture_revision += 1;
            return this.capture_settings_snapshot();
        };
        const result = this.settings_queue.then(update);
        this.settings_queue = result.catch(() => {});
        return result;
    },
    platform_for_url(url) {
        try {
            const host = new URL(url).hostname;
            if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok.com';
            if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram.com';
        } catch (_) { /* Ignore malformed request URLs. */ }
        return null;
    },
    platform_enabled(platform) {
        if (!this.capture_settings || this.capture_settings.paused) return false;
        if (platform === 'tiktok.com') return this.capture_settings.modules.tiktok;
        if (platform === 'instagram.com') {
            return this.capture_settings.modules.stories || this.capture_settings.modules.posts || this.capture_settings.modules.reels;
        }
        return false;
    },
    item_enabled(platform, item) {
        if (!this.platform_enabled(platform)) return false;
        if (platform === 'tiktok.com') return this.capture_settings.modules.tiktok;
        const kind = String(item && item._tt_type || '').toLowerCase();
        if (kind === 'story') return this.capture_settings.modules.stories;
        if (kind === 'reel') return this.capture_settings.modules.reels;
        if (kind === 'post') return this.capture_settings.modules.posts;
        return false;
    },
    enqueue(operation) {
        const work = this.queue.then(() => this.ready).then(operation);
        this.queue = work.catch(error => console.error('Tidal Tales capture failed:', error));
        return work;
    },
    listener(details) {
        // Extension downloads have no browsing tab and must never be captured again.
        if (details.tabId < 0) return {};
        const platform = this.platform_for_url(details.url);
        if (!this.platform_enabled(platform)) return {};
        const captureRevision = this.capture_revision;
        let filter;
        try { filter = browser.webRequest.filterResponseData(details.requestId); }
        catch (error) { console.error('Unable to inspect response:', error); return {}; }
        const decoder = new TextDecoder('utf-8');
        let response = '';
        let bytes = 0;
        let oversized = false;
        filter.ondata = event => {
            filter.write(event.data);
            bytes += event.data.byteLength;
            if (bytes > 32 * 1024 * 1024) { oversized = true; response = ''; }
            if (!oversized) response += decoder.decode(event.data, {stream: true});
        };
        filter.onstop = () => {
            // Release the page response before database or download work starts.
            filter.disconnect();
            if (!oversized) {
                response += decoder.decode();
                const captured = response;
                zeeschuimer.enqueue(() => zeeschuimer.parse_request(
                    captured, details.originUrl || details.url, details.url, details.tabId, captureRevision
                )).catch(() => {});
            }
            response = '';
        };
        filter.onerror = () => { response = ''; };
        return {};
    },
    async parse_request(response, source_platform_url, source_url, tabId, captureRevision = this.capture_revision) {
        if (captureRevision !== this.capture_revision || this.capture_settings.paused) return;
        try { source_platform_url = (await browser.tabs.get(tabId)).url || source_platform_url; }
        catch (_) { /* A tab may close while its response is finishing. */ }
        source_platform_url = source_platform_url || source_url;
        const oldURL = this.tab_url_map[tabId];
        if (oldURL && oldURL !== source_platform_url) await this.nav_handler(tabId);
        this.tab_url_map[tabId] = source_platform_url;
        let nav = await db.nav.where({tab_id: tabId, session: this.session}).first();
        if (!nav) {
            nav = {tab_id: tabId, session: this.session, index: 0};
            nav.id = await db.nav.add(nav);
        }
        const nav_index = `${this.session}:${tabId}:${nav.index}`;
        for (const [platform, module] of Object.entries(this.modules)) {
            if (captureRevision !== this.capture_revision || !this.platform_enabled(platform)) continue;
            let items;
            try { items = await module.callback(response, source_platform_url, source_url); }
            catch (error) { console.error(`Unable to parse ${module.name}:`, error); continue; }
            for (const item of items || []) {
                if (captureRevision !== this.capture_revision || !this.item_enabled(platform, item)) continue;
                const item_id = String(item.id || item.pk || '');
                if (!item_id) continue;
                // Serialized response processing makes this check and insert atomic
                // relative to other capture jobs, and scopes IDs by platform.
                const existing = await db.items.where({item_id, nav_index})
                    .filter(row => row.source_platform === platform).first();
                if (existing && JSON.stringify(existing.data) === JSON.stringify(item)) continue;
                // Detail responses may add media URLs missing from a profile grid.
                const data = existing ? {...existing.data} : {};
                for (const [key, value] of Object.entries(item)) {
                    if (value != null && (!Array.isArray(value) || value.length || !data[key])) data[key] = value;
                }
                if (existing && JSON.stringify(existing.data) === JSON.stringify(data)) continue;
                // Settings may change while the duplicate lookup is awaiting IndexedDB.
                if (captureRevision !== this.capture_revision || !this.item_enabled(platform, item)) continue;
                const row = {nav_index, item_id, timestamp_collected: Date.now(),
                    source_platform: platform, source_platform_url, source_url,
                    user_agent: navigator.userAgent, data, download_status: 'pending', local_files: []};
                if (existing) { row.id = existing.id; await db.items.update(row.id, row); }
                else row.id = await db.items.add(row);
                // Downloads have a separate bounded queue and cannot block capture.
                const previous = this.download_jobs.get(row.id) || Promise.resolve();
                const job = previous.then(() => tidalStorage.save(row)).then(result => db.items.update(row.id, result))
                    .catch(error => db.items.update(row.id, {download_status: 'failed', download_error: String(error)}))
                    .catch(error => console.error('Unable to record download status:', error));
                this.download_jobs.set(row.id, job);
                job.finally(() => { if (this.download_jobs.get(row.id) === job) this.download_jobs.delete(row.id); });
            }
        }
    },
    async nav_handler(details) {
        if (typeof details === 'object' && details.frameId !== undefined && details.frameId !== 0) return;
        const tabId = typeof details === 'object' ? details.tabId : details;
        const nav = await db.nav.where({session: this.session, tab_id: tabId}).first();
        if (nav) await db.nav.update(nav.id, {index: nav.index + 1});
        else await db.nav.add({session: this.session, tab_id: tabId, index: 0});
        delete this.tab_url_map[tabId];
    }
};
zeeschuimer.ready = zeeschuimer.init();
zeeschuimer.ready.catch(error => console.error('Tidal Tales database initialization failed:', error));
browser.webRequest.onBeforeRequest.addListener(details => zeeschuimer.listener(details), {
    urls: ['https://*.instagram.com/*', 'https://*.tiktok.com/*'],
    types: ['main_frame', 'xmlhttprequest']
}, ['blocking']);
browser.webNavigation.onCommitted.addListener(details => {
    zeeschuimer.enqueue(() => zeeschuimer.nav_handler(details)).catch(() => {});
}, {url: [{hostSuffix: 'instagram.com'}, {hostSuffix: 'tiktok.com'}]});
browser.tabs.onRemoved.addListener(tabId => { delete zeeschuimer.tab_url_map[tabId]; });
