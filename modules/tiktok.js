/* Adapted from Zeeschuimer's TikTok capture module.
 * Copyright (c) Stijn Peeters and contributors; MPL-2.0.
 * https://github.com/digitalmethodsinitiative/zeeschuimer
 */
(function () {
    'use strict';

    function parseJSON(response) {
        if (typeof response !== 'string' || !response) return null;
        for (const pattern of [
            /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i,
            /<script[^>]+id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i,
            /window\[['"]SIGI_STATE['"]\]\s*=\s*([\s\S]*?);\s*window\[['"]SIGI_RETRY['"]\]/
        ]) {
            const match = response.match(pattern);
            if (match) {
                try { return JSON.parse(match[1]); } catch (_) { return null; }
            }
        }
        try { return JSON.parse(response); } catch (_) { return null; }
    }

    function capture(response, sourcePlatformUrl, sourceUrl) {
        let page, request;
        try {
            page = new URL(sourcePlatformUrl || sourceUrl);
            request = new URL(sourceUrl || sourcePlatformUrl);
        } catch (_) { return []; }
        if (!/(^|\.)tiktok\.com$/i.test(page.hostname) || !/(^|\.)tiktok\.com$/i.test(request.hostname)) return [];
        if (String(sourceUrl || '').includes('/api/preload/')) return [];
        const data = parseJSON(response);
        if (!data) return [];

        const scope = data.__DEFAULT_SCOPE__;
        let items = [];
        if (scope && Array.isArray(scope['webapp.updated-items'])) {
            items = scope['webapp.updated-items'];
        } else if (scope?.['webapp.video-detail']?.itemInfo?.itemStruct) {
            items = [scope['webapp.video-detail'].itemInfo.itemStruct];
        } else if (data.ItemModule && typeof data.ItemModule === 'object') {
            items = Object.values(data.ItemModule);
        } else if (Array.isArray(data.itemList)) {
            items = data.itemList;
        } else if (Array.isArray(data.item_list)) {
            items = data.item_list;
        } else if (data.data && typeof data.data === 'object') {
            items = Object.values(data.data).filter(x => x?.type != null && x.item).map(x => x.item)
                .filter(item => ['id', 'desc', 'createTime', 'music'].every(key => key in item));
        }

        return items
            .filter(item => item && item.id != null && !item.liveRoomInfo)
            .map(item => Object.assign({}, item, { _tt_type: 'video' }));
    }

    zeeschuimer.register_module('TikTok videos', 'tiktok.com', capture);
})();
