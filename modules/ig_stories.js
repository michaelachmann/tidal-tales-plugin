zeeschuimer.register_module(
    'Stories',
    'instagram.com',
    async function (response, source_platform_url, source_url) {
        let domain = source_platform_url.split("/")[2].toLowerCase().replace(/^www\./, '');
        let endpoint = source_url.split("/").slice(3).join("/").split("?")[0].split("#")[0].replace(/\/$/, '');

        if (!["instagram.com"].includes(domain)) {
            return [];
        }

        let whitelisted_endpoints = [
            "graphql/query",
        ];

        if (!whitelisted_endpoints.includes(endpoint)) {
            return [];
        }

        console.log("Triggered");

        let data;
        try {
            // if it's JSON already, just parse it
            data = JSON.parse(response);
        } catch (SyntaxError) {
            let js_prefixes = ["window._sharedData = {", "window.__additionalDataLoaded('feed',{", "window.__additionalDataLoaded('feed_v2',{"];

            while (js_prefixes.length > 0) {
                let prefix = js_prefixes.shift();
                if (response.indexOf(prefix) === -1) {
                    continue;
                }

                let json_bit = response.split(prefix.slice(0, -1))[1].split(';</script>')[0];
                if (prefix.indexOf("additionalDataLoaded") !== -1) {
                    json_bit = json_bit.slice(0, -1);
                }
                try {
                    data = JSON.parse(json_bit);
                } catch (SyntaxError) {
                    console.error('Failed to parse JSON after finding prefix', prefix);
                }
            }

            if (!data) {
                return [];
            }
        }

        let possible_edges = ["xdt_api__v1__feed__reels_media__connection", "xdt_api__v1__feed__reels_media"];
        let edges = [];
        
        // Function to save JSON data locally
        const saveItemsLocally = async function (dataToSave, filename) {
            try {
                // Check if file already exists in download history
                const existingDownloads = await browser.downloads.search({ filename: filename, state: 'complete' });
                
                if (existingDownloads.length > 0) {
                    console.log(`File "${filename}" already exists. Skipping download.`);
                    return; // Skip download
                }

                const dataStr = JSON.stringify(dataToSave, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);

                const downloadId = await browser.downloads.download({
                    url: url,
                    filename: filename,
                    conflictAction: 'overwrite'
                });

                console.log(`Download started for "${filename}" with ID: ${downloadId}`);
            } catch (error) {
                console.error(`Error saving data locally for "${filename}":`, error);
            }
        };

        // Function to save images locally
        const saveImageLocally = async function (imageUrl, filename) {
            try {
                // Check if file already exists in download history
                const existingDownloads = await browser.downloads.search({ filename: filename, state: 'complete' });
                
                if (existingDownloads.length > 0) {
                    console.log(`Image file "${filename}" already exists. Skipping download.`);
                    return; // Skip download
                }

                const downloadId = await browser.downloads.download({
                    url: imageUrl,
                    filename: filename,
                    conflictAction: 'overwrite'
                });

                console.log(`Image download started for "${filename}" with ID: ${downloadId}`);
            } catch (error) {
                console.error(`Error saving image locally for "${filename}":`, error);
            }
        };

        // Function to save videos locally
        const saveVideoLocally = async function (videoUrl, filename) {
            try {
                // Check if file already exists in download history
                const existingDownloads = await browser.downloads.search({ filename: filename, state: 'complete' });
                
                if (existingDownloads.length > 0) {
                    console.log(`Video file "${filename}" already exists. Skipping download.`);
                    return; // Skip download
                }

                const downloadId = await browser.downloads.download({
                    url: videoUrl,
                    filename: filename,
                    conflictAction: 'overwrite'
                });

                console.log(`Video download started for "${filename}" with ID: ${downloadId}`);
            } catch (error) {
                console.error(`Error saving video locally for "${filename}":`, error);
            }
        };


        const batchDownload = async (downloadTasks, batchSize = 5) => {
            for (let i = 0; i < downloadTasks.length; i += batchSize) {
                const batch = downloadTasks.slice(i, i + batchSize);
                await Promise.all(batch.map(task => task()));
            }
        };

        const traverse = async function (obj) {
            for (const property in obj) {
                if (obj.hasOwnProperty(property)) {
                    if (possible_edges.includes(property)) {
                        console.log("Traversing:", property);
        
                        const connectionObj = obj[property];
        
                        // Check for the presence of reels_media
                        if (connectionObj.reels_media && Array.isArray(connectionObj.reels_media)) {
                            // Handling Profiles / Search
                            for (const reelMedia of connectionObj.reels_media) {
                                if (reelMedia.items && Array.isArray(reelMedia.items)) {
                                    await processReelsMedia(reelMedia);
                                }
                            }
                        } else if (connectionObj.edges && Array.isArray(connectionObj.edges)) {
                            // Handling Timeline
                            for (const edgeNode of connectionObj.edges) {
                                if (edgeNode.node && edgeNode.node.items && Array.isArray(edgeNode.node.items)) {
                                    await processReelsMedia(edgeNode.node);
                                }
                            }
                        }
                    } else if (typeof obj[property] === 'object' && obj[property] !== null) {
                        await traverse(obj[property]);
                    }
                }
            }
        };
        
        const processReelsMedia = async function (reelsMediaNode) {
            const user = reelsMediaNode.user;
            const reelItems = reelsMediaNode.items;
        
            if (reelItems) {
                for (const item of reelItems) {
                    const edge = {
                        ...item,
                        user: {
                            ...user,
                        },
                    };

                    edges.push(edge);
        
                    const baseFilename = `tidaltales/${user.username}/${item.pk}`;
                    const jsonFilename = `${baseFilename}.json`;
        
                    const downloadTasks = [
                        () => saveItemsLocally(edge, jsonFilename)
                    ];
        
                    if (item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates.length > 0) {
                        const imageUrl = item.image_versions2.candidates[0].url;
                        const imageFilename = `${baseFilename}.jpg`;
                        downloadTasks.push(() => saveImageLocally(imageUrl, imageFilename));
                    }
        
                    if (item.video_versions && item.video_versions.length > 0) {
                        const videoUrl = item.video_versions[0].url;
                        const videoFilename = `${baseFilename}.mp4`;
                        downloadTasks.push(() => saveVideoLocally(videoUrl, videoFilename));
                    }
        
                    batchDownload(downloadTasks);
                }
            }
        };
        

        const processAndSaveEdges = async function (jsonData) {
            await traverse(jsonData.data);
            if (edges.length > 0) {
                console.log('Data processing and saving completed.');
            } else {
                console.log('No edges to save.');
            }
            console.log(`Processed ${edges.length} edges.`)
            return edges;
        };

        const finalResult = await processAndSaveEdges(data);
        return finalResult;
        
    }
);
