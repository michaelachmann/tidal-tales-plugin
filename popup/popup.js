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
