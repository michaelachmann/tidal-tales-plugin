/* Adapted from Zeeschuimer's Instagram capture module.
 * Copyright (c) Stijn Peeters and contributors; MPL-2.0.
 * https://github.com/digitalmethodsinitiative/zeeschuimer
 */
(function () {
    'use strict';

    const LIST_KEYS = new Set(['items', 'edges', 'repost_grid_items', 'medias', 'feed_items', 'fill_items', 'two_by_two_item']);
    const STORY_KEYS = new Set(['xdt_api__v1__feed__reels_media__connection', 'xdt_api__v1__feed__reels_media']);

    function payloads(response) {
        if (typeof response !== 'string' || !response) return [];
        const cleaned = response.startsWith('for (;;);') ? response.slice(9) : response;
        try { return [JSON.parse(cleaned)]; } catch (_) { /* HTML below */ }
        const found = [];
        for (const match of cleaned.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
            try { found.push(JSON.parse(match[1])); } catch (_) { /* unrelated script */ }
        }
        const legacyPatterns = [
            /window\._sharedData\s*=\s*([\s\S]*?);\s*<\/script>/gi,
            /window\.__additionalDataLoaded\([^,]+,\s*([\s\S]*?)\);\s*<\/script>/gi
        ];
        for (const pattern of legacyPatterns) {
            for (const match of cleaned.matchAll(pattern)) {
                try { found.push(JSON.parse(match[1])); } catch (_) { /* unrelated script */ }
            }
        }
        return found;
    }

    function mediaLike(value) {
        return value && typeof value === 'object' &&
            (value.pk != null || value.id != null || value.code != null || value.shortcode != null) &&
            (value.media_type != null || [
                'XIGPolarisVideoMedia', 'XIGPolarisImageMedia', 'XIGPolarisPhotoMedia',
                'XIGPolarisCarouselMedia', 'GraphImage', 'GraphVideo', 'GraphSidecar'
            ].includes(value.__typename));
    }

    function normalized(item, itemType) {
        const raw = Object.assign({}, item);
        const stableId = item.pk ?? item.id ?? item.code ?? item.shortcode;
        if (raw.id != null && String(raw.id) !== String(stableId)) raw._tt_raw_id = raw.id;
        raw.id = String(stableId);
        raw._tt_type = itemType;
        return raw;
    }

    function unwrap(key, value) {
        if (key === 'two_by_two_item') return [value?.channel?.media].filter(Boolean);
        if (!Array.isArray(value)) return [];
        if (key === 'feed_items') return value.map(x => x?.media_or_ad).filter(Boolean);
        if (key === 'medias' || key === 'fill_items') {
            return value.flatMap(x => [x?.media, ...(x?.clips?.items || []).map(y => y?.media)].filter(Boolean));
        }
        return value.flatMap(entry => {
            const node = entry?.node || entry;
            if (node?.media) return [node.media];
            if (Array.isArray(node?.items)) return node.items.map(x => x?.media || x).filter(Boolean);
            return [node];
        });
    }

    function type(item) {
        return ['clips', 'reel'].includes(String(item.product_type || '').toLowerCase()) ||
            item.__typename === 'XIGPolarisVideoMedia' ? 'reel' : 'post';
    }

    function stories(container, output) {
        const reels = Array.isArray(container?.reels_media) ? container.reels_media :
            (container?.edges || []).map(edge => edge?.node).filter(Boolean);
        for (const reel of reels) {
            for (const item of reel?.items || []) {
                if (item?.id == null && item?.pk == null) continue;
                const raw = normalized(item, 'story');
                if (!raw.user && reel.user) raw.user = reel.user;
                output.push(raw);
            }
        }
    }

    function walk(value, output, seen, view) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            // Comet/Relay wrappers store the useful API object as serialized JSON.
            if (key === 'response' && typeof child === 'string') {
                try { walk(JSON.parse(child), output, seen, view); } catch (_) { /* not a JSON response */ }
                continue;
            }
            if (STORY_KEYS.has(key)) {
                stories(child, output);
                continue;
            }
            if (key === 'shortcode_media' || key === 'xdt_shortcode_media') {
                if (mediaLike(child)) output.push(normalized(child, type(child)));
                continue;
            }
            if (key === 'xdt_api__v1__feed__timeline__connection') {
                if (view !== 'frontpage') continue;
                for (const edge of child?.edges || []) {
                    const item = edge?.node?.media || edge?.node?.explore_story?.media;
                    if (mediaLike(item)) output.push(normalized(item, type(item)));
                }
                continue;
            }
            if (['xdt_api__v1__feed__user_timeline_graphql_connection', 'xdt_location_get_web_info_tab'].includes(key)) {
                for (const edge of child?.edges || []) {
                    if (mediaLike(edge?.node)) output.push(normalized(edge.node, type(edge.node)));
                }
                continue;
            }
            if (LIST_KEYS.has(key)) {
                if (['medias', 'fill_items'].includes(key) && !['explore', 'search'].includes(view)) continue;
                for (const item of unwrap(key, child)) {
                    if (!mediaLike(item) || item.is_seen === false || item.product_type === 'ad') continue;
                    if (item.link?.startsWith('https://www.facebook.com/ads/')) continue;
                    output.push(normalized(item, type(item)));
                }
                // Do not descend into captured media. In particular, carousel
                // children are attachments of the parent, not separate posts.
                continue;
            }
            walk(child, output, seen, view);
        }
    }

    function capture(response, sourcePlatformUrl, sourceUrl) {
        let page, request;
        try {
            page = new URL(sourcePlatformUrl || sourceUrl);
            request = new URL(sourceUrl || sourcePlatformUrl);
        } catch (_) { return []; }
        if (!/(^|\.)instagram\.com$/i.test(page.hostname) || !/(^|\.)instagram\.com$/i.test(request.hostname)) return [];
        if (String(sourceUrl || '').includes('injected_story_units')) return [];
        const path = page.pathname.split('/').filter(Boolean);
        if (['direct', 'account', 'directory', 'lite', 'legal', 'static_resources'].includes(path[0])) return [];

        let view = '';
        if (path.length === 0) view = 'frontpage';
        else if (path[0] === 'explore') view = path[1] === 'locations' ? 'location' : (path[1] === 'search' ? 'search' : 'explore');
        else if (path[0] === 'stories') view = 'stories';
        else if (path[0] === 'p') view = 'single_post';
        else if (path[0] === 'reel' || path[0] === 'reels') view = path.length > 1 ? 'single_reel' : 'reels';
        else if (path.length === 1) view = 'user_posts';
        else if (path[1] === 'p') view = 'single_post';
        else if (path[1] === 'reel' || path[1] === 'reels') view = path[2] ? 'single_reel' : 'user_reels';
        else if (path[1] === 'tagged') view = 'user_tagged';
        else if (path[1] === 'reposts') view = 'user_reposts';

        const graphql = /\/graphql(?:\/query)?\/?(?:[?#]|$)/.test(request.pathname + request.search);
        const graphqlViews = new Set(['frontpage', 'explore', 'location', 'search', 'user_posts', 'user_reels', 'user_tagged', 'user_reposts', 'stories']);
        if (graphql && !graphqlViews.has(view)) return [];
        if (request.pathname.includes('/api/v1/discover/web/explore_grid/') && view !== 'explore') return [];

        const found = [];
        for (const data of payloads(response)) walk(data, found, new Set(), view);
        const requestedMatch = page.pathname.match(/\/(?:p|reel|reels)\/([^/]+)/);
        const requested = requestedMatch?.[1] === 'audio' ? null : requestedMatch?.[1];
        const unique = new Map();
        for (const item of found) {
            const shortcode = item.code ?? item.shortcode;
            if (requested && shortcode !== requested) continue;
            unique.set(String(item.id), item);
        }
        return [...unique.values()];
    }

    zeeschuimer.register_module('Instagram posts, reels & stories', 'instagram.com', capture);
})();
