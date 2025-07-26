// Import the CyclistWindAnalyzer class
import CyclistWindAnalyzer from './CyclistWindAnalyzer.js';

// Initialize the application
const analyzer = new CyclistWindAnalyzer();

// Drag and drop functionality
const fileDropArea = document.getElementById("fileDropArea");
const fileInput = document.getElementById("gpxFile");

// Prevent default drag behaviors
["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    fileDropArea.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

// Highlight drop area when item is dragged over it
["dragenter", "dragover"].forEach((eventName) => {
    fileDropArea.addEventListener(eventName, highlight, false);
});

["dragleave", "drop"].forEach((eventName) => {
    fileDropArea.addEventListener(eventName, unhighlight, false);
});

function highlight(e) {
    fileDropArea.classList.add("bg-blue-100", "border-blue-700", "-translate-y-0.5");
}

function unhighlight(e) {
    fileDropArea.classList.remove("bg-blue-100", "border-blue-700", "-translate-y-0.5");
}

// Handle dropped files
fileDropArea.addEventListener("drop", handleDrop, false);

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;

    if (files.length > 0) {
        handleFileSelection(files[0]);
    }
}

async function handleFileSelection(file) {
    if (file && file.name.toLowerCase().endsWith(".gpx")) {
        try {
            console.log(
                `Processing GPX file: ${file.name} (${file.size} bytes)`
            );
            const success = await analyzer.readGPXFile(file);
            if (success) {
                document.querySelector(
                    'label[for="gpxFile"]'
                ).innerHTML = `✅ ${file.name}<br><small>Analyzing ${analyzer.gpxData.length} GPS points...</small>`;

                try {
                    await analyzer.analyze();
                    // Analysis completed successfully - results should now be visible
                } catch (error) {
                    console.error("Analysis error:", error);
                    alert("Error during analysis: " + error.message);

                    // Reset the file label
                    document.querySelector(
                        'label[for="gpxFile"]'
                    ).innerHTML = `❌ ${file.name}<br><small class="text-red-600">Analysis failed</small>`;
                }
            } else {
                throw new Error("No valid GPS data found in file");
            }
        } catch (error) {
            console.error("Error reading GPX file:", error);

            // Provide more specific error messages
            let errorMessage = "Error reading GPX file: " + error.message;
            if (error.message.includes("No GPS points found")) {
                errorMessage +=
                    "\n\nThis GPX file might be:\n• A waypoint-only file\n• Missing track/route data\n• Corrupted or incomplete";
            } else if (error.message.includes("Invalid GPX file format")) {
                errorMessage +=
                    "\n\nPlease ensure this is a valid GPX file exported from a GPS device or cycling app.";
            }

            alert(errorMessage);
            document.querySelector(
                'label[for="gpxFile"]'
            ).innerHTML = `❌ ${file.name}<br><small class="text-red-600">Failed to load file</small>`;
        }
    } else {
        alert("Please select a valid GPX file (.gpx extension required).");
    }
}

// Upload New File button functionality
document
    .getElementById("uploadNewBtn")
    .addEventListener("click", function () {
        const upload = document.querySelector(".bg-white.rounded-lg.p-12");
        const results = document.getElementById("results");
        const loading = document.getElementById("loading");
        const fileDropArea = document.getElementById("fileDropArea");

        // Show upload section and file drop area
        if (upload) {
            upload.classList.remove("hidden");
            upload.classList.add("show");
        }
        if (fileDropArea) {
            fileDropArea.classList.remove("hidden");
            fileDropArea.classList.add("show");
        }

        // Hide results and loading
        if (results) {
            results.classList.add("hidden");
            results.classList.remove("show");
        }
        if (loading) {
            loading.classList.add("hidden");
            loading.classList.remove("show");
        }

        // Reset form
        document.getElementById("gpxFile").value = "";
        document.querySelector('label[for="gpxFile"]').innerHTML =
            "📁 Choose GPX File or Drag & Drop<br><small>Analysis will start automatically once loaded</small>";

        // Clear any existing data
        analyzer.gpxData = [];
        analyzer.windData = [];
        if (analyzer.map) {
            analyzer.map.remove();
            analyzer.map = null;
        }
    });

// Event listeners
document
    .getElementById("gpxFile")
    .addEventListener("change", async function (event) {
        const file = event.target.files[0];
        if (file) {
            await handleFileSelection(file);
        }
    });

// Load Example button functionality
document
    .getElementById("loadExampleBtn")
    .addEventListener("click", async function () {
        try {

            // Fetch the example GPX file
            const response = await fetch('./example.gpx');
            if (!response.ok) {
                throw new Error(`Failed to load example file: ${response.status}`);
            }

            const gpxText = await response.text();

            // Create a File-like object from the text
            const blob = new Blob([gpxText], { type: 'application/gpx+xml' });
            const file = new File([blob], 'example.gpx', { type: 'application/gpx+xml' });

            // Process the example file using the same logic as file upload
            await handleFileSelection(file);

        } catch (error) {
            console.error("Error loading example file:", error);
            alert("Failed to load example file: " + error.message);
        }
    });
