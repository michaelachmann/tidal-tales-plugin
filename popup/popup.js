document.addEventListener('DOMContentLoaded', async () => {
    const background = browser.extension.getBackgroundPage();

    // Fetch version from manifest
    const manifestData = await browser.runtime.getManifest();
    document.getElementById('version').textContent = `Version: ${manifestData.version}`;

    // Update the stats
    updateStats();
});

async function updateStats() {
    const background = browser.extension.getBackgroundPage();
    let response = [];
    let platformMap = [];
    Object.keys(background.zeeschuimer.modules).forEach(function(platform) { 
        platformMap[platform] = background.zeeschuimer.modules[platform].name; 
    });

    for (let module in background.zeeschuimer.modules) {
        response[module] = await background.db.items.where("source_platform").equals(module).count();
    }

    const tbody = document.querySelector("#item-table tbody");
    tbody.innerHTML = ''; // Clear the table body

    for (let platform in response) {
        let row = document.createElement("tr");
        let platformCell = document.createElement("td");
        platformCell.textContent = platformMap[platform];
        let itemsCell = document.createElement("td");
        itemsCell.textContent = new Intl.NumberFormat().format(response[platform]);

        row.appendChild(platformCell);
        row.appendChild(itemsCell);
        tbody.appendChild(row);
    }

    // Hide the status element after successfully loading data
    document.getElementById('status').style.display = 'none';
}

document.getElementById('clear-data').addEventListener('click', async () => {
    const background = browser.extension.getBackgroundPage();
    await background.db.items.clear();
    updateStats(); // Update the stats after clearing data
});


// Export database records as CSV
async function exportDatabaseToCSV() {
    const background = browser.extension.getBackgroundPage();
    const dbItems = await background.db.items.toArray(); // Get all items from the database
    
    // Prepare CSV column headers
    const csvHeaders = [
        'ID', 'Time of Posting', 'Type of Content', 'video_path', 'image_path', 'Username',
        'Video Length (s)', 'Expiration', 'Caption', 'Is Verified', 'Stickers', 
        'Accessibility Caption', 'Attribution URL', 'Story Media', 'Story Hashtags',
        'Story Questions', 'Story Sliders', 'Story CTA', 'Story Countdowns', 'Story Locations'
    ];

    // Function to escape fields that may contain commas or quotes
    const escapeCSV = (value) => {
        if (value == null) return '';
        const str = value.toString();
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`; // Escape double quotes by doubling them
        }
        return str;
    };

    // Map database items to the CSV structure
    const rows = dbItems.map(item => {
        const data = item.data;
        const user = data.user || {};
        return {
            'ID': data.pk,
            'Time of Posting': new Date(data.taken_at * 1000).toISOString(), // Convert timestamp to ISO string
            'Type of Content': data.media_type === 2 ? 'Video' : 'Image',
            'video_path': data.media_type === 2 ? `${user.username}/${data.pk}.mp4` : null,
            'image_path': data.image_versions2 ? `${user.username}/${data.pk}.jpg` : null,
            'Username': user.username,
            'Video Length (s)': data.video_duration || null,
            'Expiration': new Date(data.expiring_at * 1000).toISOString(), // Convert timestamp to ISO string
            'Caption': data.caption || null,
            'Is Verified': user.is_verified,
            'Stickers': JSON.stringify(data.story_bloks_stickers || []),
            'Accessibility Caption': data.accessibility_caption || '',
            'Attribution URL': data.attribution_content_url || '',
            'Story Media': JSON.stringify(data.story_feed_media || []),
            'Story Hashtags': JSON.stringify(data.story_hashtags || []),
            'Story Questions': JSON.stringify(data.story_questions || []),
            'Story Sliders': JSON.stringify(data.story_sliders || []),
            'Story CTA': JSON.stringify(data.story_cta || []),
            'Story Countdowns': JSON.stringify(data.story_countdowns || []),
            'Story Locations': JSON.stringify(data.story_locations || [])
        };
    });

    // Convert to CSV format
    const csvContent = [
        csvHeaders.join(','), // Join the headers by comma
        ...rows.map(row => csvHeaders.map(header => escapeCSV(row[header])).join(',')) // Join the row data, escaping as necessary
    ].join('\n'); // Join rows by newline

    // Get current date and time to create a unique file name
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:\-]/g, '').replace(/\..*$/, ''); // Format: YYYYMMDDTHHMMSS
    const fileName = `tidaltales_export_${timestamp}.csv`;

    // Create a blob and a link to download the CSV
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
}


// Add an event listener to a button to trigger CSV export
document.getElementById('export-csv').addEventListener('click', exportDatabaseToCSV);