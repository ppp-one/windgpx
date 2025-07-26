class CyclistWindAnalyzer {
    constructor() {
        this.gpxData = [];
        this.windData = [];
        this.map = null;
        this.routeMarkers = [];
        this.currentHoverMarker = null;
        this.charts = {
            time: null,
            scatter: null,
            speed: null,
            elevation: null,
            wind: null
        };
        this.chartData = {
            speed: null,
            elevation: null,
            wind: null
        };
        this.isSyncing = false;
        this.mapUpdateTimeout = null;
        this.currentSyncIndex = -1;
        this.currentXAxis = "distance";
        this.lastHighlightIndex = -1; // Track last highlighted index to avoid redundant updates

        // Performance optimization: Throttle map updates for better responsiveness
        this.throttledMapUpdate = this.throttle(this.updateMapHighlight.bind(this), 8);

        // Constants for better maintainability
        this.CONSTANTS = {
            MAX_REALISTIC_SPEED: 100, // km/h
            MIN_MOVEMENT_THRESHOLD: 1, // meters
            WIND_FETCH_INTERVAL: 30 * 60 * 1000, // 30 minutes
            API_DELAY: 200, // ms between API calls
            MAP_HEIGHT: 400,
            CHART_HEIGHT: 180,
            DEFAULT_WIND_SPEED: 10,
            DEFAULT_WIND_DIRECTION: 180
        };
    }

    // Utility function for throttling (better for real-time updates than debouncing)
    throttle(func, wait) {
        let timeout;
        let previous = 0;
        let context, args;

        return function executedFunction(...newArgs) {
            const now = Date.now();
            const remaining = wait - (now - previous);

            context = this;
            args = newArgs;

            if (remaining <= 0 || remaining > wait) {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                previous = now;
                func.apply(context, args);
            } else if (!timeout) {
                timeout = setTimeout(() => {
                    previous = Date.now();
                    timeout = null;
                    func.apply(context, args);
                }, remaining);
            }
        };
    }

    async readGPXFile(file) {
        if (!file) {
            throw new Error("No file provided");
        }

        const text = await file.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "text/xml");

        // Check for parsing errors
        const parserError = xmlDoc.querySelector("parsererror");
        if (parserError) {
            throw new Error("Invalid GPX file format");
        }

        const points = this.extractGPXPoints(xmlDoc);

        if (points.length === 0) {
            throw new Error("No valid GPS points with coordinates found in file");
        }

        // Validate timestamps
        this.validateTimestamps(points);

        // Sort by time and store
        this.gpxData = points.sort((a, b) => a.time - b.time);

        console.log(`Time range: ${this.gpxData[0].time.toISOString()} to ${this.gpxData[this.gpxData.length - 1].time.toISOString()}`);

        this.calculateSpeedAndBearing();

        console.log(`Successfully loaded ${this.gpxData.length} GPS points from GPX file`);
        return this.gpxData.length > 0;
    }

    extractGPXPoints(xmlDoc) {
        const points = [];

        // Try different GPX structures in order of preference
        const pointSelectors = ["trkpt", "rtept", "wpt"];
        let trackPoints = [];

        for (const selector of pointSelectors) {
            trackPoints = xmlDoc.querySelectorAll(selector);
            console.log(`Found ${trackPoints.length} ${selector} points`);
            if (trackPoints.length > 0) break;
        }

        if (trackPoints.length === 0) {
            throw new Error("No GPS points found in GPX file. Please ensure your file contains track points, route points, or waypoints.");
        }

        for (const point of trackPoints) {
            const lat = parseFloat(point.getAttribute("lat"));
            const lon = parseFloat(point.getAttribute("lon"));

            // Validate coordinates
            if (!this.isValidCoordinate(lat, lon)) {
                console.warn("Skipping point with invalid coordinates:", { lat, lon });
                continue;
            }

            const elevation = this.extractElevation(point);
            const time = this.extractTimestamp(point, points.length);

            points.push({ lat, lon, elevation, time });
        }

        return points;
    }

    isValidCoordinate(lat, lon) {
        return lat && lon &&
            !isNaN(lat) && !isNaN(lon) &&
            lat >= -90 && lat <= 90 &&
            lon >= -180 && lon <= 180;
    }

    extractElevation(point) {
        const eleElement = point.querySelector("ele");
        if (eleElement?.textContent) {
            const eleValue = parseFloat(eleElement.textContent);
            return !isNaN(eleValue) ? eleValue : 0;
        }
        return 0;
    }

    extractTimestamp(point, pointIndex) {
        const timeElement = point.querySelector("time");
        if (!timeElement?.textContent) {
            return null;
        }

        try {
            const timeString = timeElement.textContent.trim();
            //console.log(`Processing timestamp: "${timeString}"`);

            let time = new Date(timeString);

            // Handle invalid timestamps with fallback parsing
            if (isNaN(time.getTime())) {
                time = this.parseAlternativeTimeFormats(timeString);
            }

            return isNaN(time.getTime()) ? null : time;
        } catch (error) {
            console.warn(`Error parsing time for point ${pointIndex}:`, error);
            return null;
        }
    }

    parseAlternativeTimeFormats(timeString) {
        // Try ISO format variations
        if (timeString.includes("T") && !timeString.includes("Z") && !timeString.includes("+")) {
            return new Date(timeString + "Z");
        }

        // Try space-separated format
        if (timeString.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
            return new Date(timeString.replace(" ", "T") + "Z");
        }

        return new Date(NaN); // Invalid date
    }

    validateTimestamps(points) {
        const hasValidTimes = points.some(p =>
            p.time !== null &&
            !isNaN(p.time.getTime()) &&
            p.time.getFullYear() > 2000
        );

        console.log(`Valid timestamps found: ${hasValidTimes}`);
        console.log(`Points with timestamps: ${points.filter(p => p.time !== null).length}/${points.length}`);

        if (!hasValidTimes) {
            throw new Error(`This GPX file does not contain valid timestamps.

Wind analysis requires GPS tracks with accurate time data to:
• Fetch historical weather data for the correct date/time
• Calculate cycling speeds and performance metrics  
• Provide meaningful wind impact analysis

Please use a GPX file that includes timestamp information for each GPS point. Most modern GPS devices and cycling computers (Garmin, Wahoo, etc.) automatically include this data.

If you recorded this track without timestamps, you may need to re-record your route or use a different GPX file.`);
        }
    }

    calculateSpeedAndBearing() {
        let cumulativeDistance = 0;
        console.log("Starting speed and bearing calculations...");

        for (let i = 0; i < this.gpxData.length; i++) {
            if (i === 0) {
                // Initialize first point
                Object.assign(this.gpxData[i], {
                    speed_kmh: 0,
                    bearing: 0,
                    distance_km: 0
                });
                continue;
            }

            const prev = this.gpxData[i - 1];
            const curr = this.gpxData[i];

            this.calculatePointMetrics(prev, curr, i, cumulativeDistance);
            cumulativeDistance = curr.distance_km * 1000; // Convert back to meters for next iteration
        }

        this.logSpeedStatistics();
    }

    calculatePointMetrics(prev, curr, index, cumulativeDistance) {
        // Calculate distance
        const distance = this.haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);

        // Update cumulative distance
        cumulativeDistance += distance;
        curr.distance_km = cumulativeDistance / 1000;

        // Calculate time difference
        const timeDiff = (curr.time - prev.time) / 1000; // seconds

        // Calculate speed
        curr.speed_kmh = this.calculateSpeed(distance, timeDiff, prev.speed_kmh);

        // Calculate bearing
        curr.bearing = this.calculatePointBearing(prev, curr, distance);
    }

    calculateSpeed(distance, timeDiff, prevSpeed = 0) {
        if (timeDiff <= 0) {
            console.warn(`Invalid time difference: ${timeDiff}s`);
            return prevSpeed;
        }

        if (distance <= 0) {
            return 0; // No movement
        }

        const speedMs = distance / timeDiff;
        let speedKmh = speedMs * 3.6;

        // Cap unrealistic speeds
        if (speedKmh > this.CONSTANTS.MAX_REALISTIC_SPEED) {
            console.warn(`Unrealistic speed detected: ${speedKmh.toFixed(1)} km/h, using previous speed`);
            speedKmh = prevSpeed || 20; // Default to reasonable cycling speed
        }

        // Handle very low speeds that might indicate GPS errors
        if (speedKmh < 0.1 && distance > 5) {
            console.warn(`Very low speed detected: ${speedKmh.toFixed(1)} km/h for ${distance.toFixed(1)}m movement`);
        }

        return speedKmh;
    }

    calculatePointBearing(prev, curr, distance) {
        // Only calculate bearing for significant movements
        if (distance > this.CONSTANTS.MIN_MOVEMENT_THRESHOLD) {
            return this.calculateBearing(prev.lat, prev.lon, curr.lat, curr.lon);
        }
        return prev.bearing || 0;
    }

    logSpeedStatistics() {
        const speeds = this.gpxData.map(p => p.speed_kmh).filter(s => s > 0);
        const totalDistance = this.gpxData[this.gpxData.length - 1]?.distance_km || 0;

        const stats = {
            avgSpeed: speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
            maxSpeed: speeds.length > 0 ? Math.max(...speeds) : 0,
            zeroSpeedPoints: this.gpxData.filter(p => p.speed_kmh === 0).length
        };

        console.log(`Calculated speeds and bearings for ${this.gpxData.length} points`);
        console.log(`Total distance: ${totalDistance.toFixed(2)} km`);
        console.log(`Average speed: ${stats.avgSpeed.toFixed(1)} km/h`);
        console.log(`Max speed: ${stats.maxSpeed.toFixed(1)} km/h`);
        console.log(`Points with zero speed: ${stats.zeroSpeedPoints}`);
    }

    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000; // Earth's radius in meters
        const dLat = this.toRadians(lat2 - lat1);
        const dLon = this.toRadians(lon2 - lon1);

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    calculateBearing(lat1, lon1, lat2, lon2) {
        const dLon = this.toRadians(lon2 - lon1);
        const lat1Rad = this.toRadians(lat1);
        const lat2Rad = this.toRadians(lat2);

        const y = Math.sin(dLon) * Math.cos(lat2Rad);
        const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

        let bearing = this.toDegrees(Math.atan2(y, x));
        return (bearing + 360) % 360;
    }

    toRadians(degrees) {
        return degrees * (Math.PI / 180);
    }

    toDegrees(radians) {
        return radians * (180 / Math.PI);
    }

    async getWindDataEvery30Min() {
        const startTime = this.gpxData[0].time;
        const endTime = this.gpxData[this.gpxData.length - 1].time;
        const interval = this.CONSTANTS.WIND_FETCH_INTERVAL;

        // Wait a bit for the loading screen to be visible before resetting progress
        await this.delay(100);

        // Reset progress bar
        this.updateProgress(0, 1);

        let currentTime = new Date(startTime);
        this.windData = [];

        const totalSteps = Math.ceil((endTime - startTime) / interval);
        let currentStep = 0;

        console.log(`Starting wind data fetch for ${totalSteps} time points`);

        while (currentTime <= endTime) {
            const closestPoint = this.findClosestGPXPoint(currentTime);

            try {
                const windInfo = await this.getHistoricalWeatherOpenMeteo(
                    closestPoint.lat,
                    closestPoint.lon,
                    currentTime
                );

                this.windData.push({
                    ...windInfo,
                    time: new Date(currentTime),
                    lat: closestPoint.lat,
                    lon: closestPoint.lon
                });

                await this.delay(this.CONSTANTS.API_DELAY);

            } catch (error) {
                console.warn(`Error getting wind data for ${currentTime}:`, error);
                this.windData.push(this.createDefaultWindData(currentTime, closestPoint));
            }

            // Update progress after each step, regardless of success or failure
            this.updateProgress(++currentStep, totalSteps);
            currentTime = new Date(currentTime.getTime() + interval);
        }

        // Ensure progress bar shows 100% completion
        this.updateProgress(totalSteps, totalSteps);
        console.log(`Retrieved wind data for ${this.windData.length} time points`);
    }

    findClosestGPXPoint(targetTime) {
        let closestPoint = this.gpxData[0];
        let minTimeDiff = Math.abs(targetTime - closestPoint.time);

        for (const point of this.gpxData) {
            const timeDiff = Math.abs(targetTime - point.time);
            if (timeDiff < minTimeDiff) {
                minTimeDiff = timeDiff;
                closestPoint = point;
            }
        }

        return closestPoint;
    }

    createDefaultWindData(time, point) {
        return {
            time: new Date(time),
            lat: point.lat,
            lon: point.lon,
            wind_speed: this.CONSTANTS.DEFAULT_WIND_SPEED,
            wind_direction: this.CONSTANTS.DEFAULT_WIND_DIRECTION
        };
    }

    updateProgress(currentStep, totalSteps) {
        const progress = (currentStep / totalSteps) * 100;
        const progressFill = document.getElementById("progressFill");

        if (progressFill) {
            progressFill.style.width = `${progress}%`;
        } else {
            console.warn("Progress bar element 'progressFill' not found");
        }
    }

    async getHistoricalWeatherOpenMeteo(lat, lon, timestamp) {
        const dateStr = timestamp.toISOString().split("T")[0];
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateStr}&end_date=${dateStr}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC`;

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        return this.parseWeatherData(data, timestamp);
    }

    parseWeatherData(data, timestamp) {
        if (!data.hourly?.time?.length) {
            throw new Error("No hourly data available");
        }

        // Find closest hour
        let closestIdx = 0;
        let minDiff = Infinity;

        for (let i = 0; i < data.hourly.time.length; i++) {
            const apiTime = new Date(data.hourly.time[i]);
            const diff = Math.abs(apiTime - timestamp);
            if (diff < minDiff) {
                minDiff = diff;
                closestIdx = i;
            }
        }

        const windSpeed10m = (data.hourly.wind_speed_10m[closestIdx] || 0) * 3.6; // Convert to km/h
        const windDirection = data.hourly.wind_direction_10m[closestIdx] || 0;
      
        //Ianto Cannon Jul 26: calculate the wind speed 1.5m above the ground, assuming a roughness length of 0.1m
        const windSpeed = windSpeed10m * (Math.log(1.5 / 0.1) / Math.log(10 / 0.1));

        return { wind_speed: windSpeed, wind_direction: windDirection };
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    interpolateWindAlongRoute() {
        // Improved interpolation with boundary handling
        for (const gpxPoint of this.gpxData) {
            const windData = this.interpolateWindForPoint(gpxPoint);
            Object.assign(gpxPoint, windData);
        }

        this.calculateRelativeWind();
    }

    interpolateWindForPoint(gpxPoint) {
        // Handle edge cases first
        if (this.windData.length === 0) {
            return {
                wind_speed: this.CONSTANTS.DEFAULT_WIND_SPEED,
                wind_direction: this.CONSTANTS.DEFAULT_WIND_DIRECTION
            };
        }

        if (this.windData.length === 1) {
            return {
                wind_speed: this.windData[0].wind_speed,
                wind_direction: this.windData[0].wind_direction
            };
        }

        // Find surrounding wind data points
        const { before, after } = this.findSurroundingWindData(gpxPoint.time);

        if (before && after) {
            return this.interpolateBetweenWindPoints(before, after, gpxPoint.time);
        }

        // Use closest available data
        const closest = before || after || this.windData[0];
        return {
            wind_speed: closest.wind_speed,
            wind_direction: closest.wind_direction
        };
    }

    findSurroundingWindData(targetTime) {
        let before = null;
        let after = null;

        for (let i = 0; i < this.windData.length - 1; i++) {
            if (this.windData[i].time <= targetTime && this.windData[i + 1].time >= targetTime) {
                before = this.windData[i];
                after = this.windData[i + 1];
                break;
            }
        }

        return { before, after };
    }

    interpolateBetweenWindPoints(before, after, targetTime) {
        const totalTime = after.time - before.time;
        const pointTime = targetTime - before.time;
        const ratio = totalTime > 0 ? pointTime / totalTime : 0;

        return {
            wind_speed: before.wind_speed + (after.wind_speed - before.wind_speed) * ratio,
            wind_direction: before.wind_direction + (after.wind_direction - before.wind_direction) * ratio
        };
    }

    calculateRelativeWind() {
        for (const point of this.gpxData) {
            const windFromDeg = point.wind_direction;
            const cyclistDirection = point.bearing;

            // Calculate relative angle
            const relativeAngle = ((windFromDeg - cyclistDirection + 180) % 360) - 180;

            // Calculate wind component in cyclist's direction
            const windComponent = point.wind_speed * Math.cos(this.toRadians(relativeAngle));
            point.wind_faced = windComponent;
        }

        console.log("Calculated relative wind for all points");
    }

    createBinnedData(xData, yData, binCount = 20) {
        const minX = Math.min(...xData);
        const maxX = Math.max(...xData);
        const binWidth = (maxX - minX) / binCount;

        const bins = [];
        for (let i = 0; i < binCount; i++) {
            const binStart = minX + i * binWidth;
            const binEnd = binStart + binWidth;
            const binData = [];

            for (let j = 0; j < xData.length; j++) {
                if (xData[j] >= binStart && xData[j] < binEnd) {
                    binData.push(yData[j]);
                }
            }

            if (binData.length > 0) {
                const mean = binData.reduce((a, b) => a + b, 0) / binData.length;
                const std = Math.sqrt(
                    binData.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / binData.length
                );
                const sem = std / Math.sqrt(binData.length);

                bins.push({
                    x: binStart + binWidth / 2,
                    y: mean,
                    error: sem,
                    count: binData.length
                });
            }
        }

        return bins;
    }

    createCharts() {
        // Small delay to ensure containers are properly sized
        setTimeout(() => {
            this.createSpeedChart(this.currentXAxis);
            this.createElevationChart(this.currentXAxis);
            this.createWindChart(this.currentXAxis);
            this.setupChartToggles();
        }, 100);
    }

    createSpeedChart(xAxis = "time") {
        const container = document.getElementById("speedChart");
        if (!container) return;

        container.innerHTML = "";
        container.style.height = `${this.CONSTANTS.CHART_HEIGHT + 40}px`;

        const data = this.gpxData.map((p, i) => ({
            x: xAxis === "time" ? p.time : p.distance_km,
            y: p.speed_kmh,
            dataIndex: i
        }));

        this.chartData.speed = data;
        this.renderSpeedChart(container, data, xAxis);
    }

    renderSpeedChart(container, data, xAxis = "time") {
        if (!window.Plot) {
            console.error("Observable Plot not available");
            return;
        }

        const plot = Plot.plot({
            width: container.clientWidth,
            height: this.CONSTANTS.CHART_HEIGHT,
            marginLeft: 30,
            marginRight: 10,
            marginBottom: 50,
            marginTop: 30,
            x: {
                label: xAxis === "time" ? "Time" : "Distance (km)",
                type: xAxis === "time" ? "utc" : "linear"
            },
            y: {
                label: "Speed (km/h)",
                grid: true,
                domain: [0, Math.max(...data.map(d => d.y)) * 1.1],
                nice: true
            },
            marks: [
                Plot.line(data, {
                    x: "x",
                    y: "y",
                    stroke: "#1976d2",
                    strokeWidth: 3,
                    curve: "step-before"
                }),
                Plot.ruleX(data, Plot.pointerX({
                    x: "x",
                    stroke: "#ff4757",
                    strokeWidth: 2,
                    strokeDasharray: "5,3"
                })),
                Plot.dot(data, Plot.pointerX({
                    x: "x",
                    y: "y",
                    r: 6,
                    fill: "#ff4757",
                    stroke: "#fff",
                    strokeWidth: 2
                })),
                Plot.text(data, Plot.pointerX({
                    x: "x",
                    y: "y",
                    dy: -15,
                    text: d => `${d.y.toFixed(1)} km/h`,
                    fill: "#000",
                    fontSize: 12,
                    fontWeight: "bold",
                    textAnchor: "middle"
                }))
            ]
        });

        container.innerHTML = "";
        container.appendChild(plot);
        this.addMapInteraction(container, data);
        this.charts.speed = plot;
    }

    createElevationChart(xAxis = "time") {
        const container = document.getElementById("elevationChart");
        if (!container) return;

        container.innerHTML = "";
        container.style.height = `${this.CONSTANTS.CHART_HEIGHT + 40}px`;

        const data = this.gpxData.map((p, i) => ({
            x: xAxis === "time" ? p.time : p.distance_km,
            y: p.elevation,
            dataIndex: i
        }));

        this.chartData.elevation = data;
        this.renderElevationChart(container, data, xAxis);
    }

    renderElevationChart(container, data, xAxis = "time") {
        if (!window.Plot) {
            console.error("Observable Plot not available");
            return;
        }

        const minY = Math.min(...data.map(d => d.y));
        const maxY = Math.max(...data.map(d => d.y));
        const yPadding = (maxY - minY) * 0.1;

        const plot = Plot.plot({
            width: container.clientWidth,
            height: this.CONSTANTS.CHART_HEIGHT,
            marginLeft: 30,
            marginRight: 10,
            marginBottom: 50,
            marginTop: 30,
            x: {
                label: xAxis === "time" ? "Time" : "Distance (km)",
                type: xAxis === "time" ? "utc" : "linear"
            },
            y: {
                label: "Elevation (m)",
                grid: true,
                domain: [minY - yPadding, maxY + yPadding],
                nice: true
            },
            marks: [
                Plot.line(data, {
                    x: "x",
                    y: "y",
                    stroke: "#2e7d32",
                    strokeWidth: 3,
                    curve: "step-before"
                }),
                Plot.ruleX(data, Plot.pointerX({
                    x: "x",
                    stroke: "#ff4757",
                    strokeWidth: 2,
                    strokeDasharray: "5,3"
                })),
                Plot.dot(data, Plot.pointerX({
                    x: "x",
                    y: "y",
                    r: 6,
                    fill: "#ff4757",
                    stroke: "#fff",
                    strokeWidth: 2
                })),
                Plot.text(data, Plot.pointerX({
                    x: "x",
                    y: "y",
                    dy: -15,
                    text: d => `${d.y.toFixed(0)}m`,
                    fill: "#000",
                    fontSize: 12,
                    fontWeight: "bold",
                    textAnchor: "middle"
                }))
            ]
        });

        container.innerHTML = "";
        container.appendChild(plot);
        this.addMapInteraction(container, data);
        this.charts.elevation = plot;
    }

    createWindChart(xAxis = "time") {
        const container = document.getElementById("windChart");
        if (!container) return;

        container.innerHTML = "";
        container.style.height = `${this.CONSTANTS.CHART_HEIGHT + 40}px`;

        const data = this.gpxData.map((p, i) => ({
            x: xAxis === "time" ? p.time : p.distance_km,
            y: p.wind_faced,
            dataIndex: i,
            windType: p.wind_faced >= 0 ? "headwind" : "tailwind"
        }));

        this.chartData.wind = data;
        this.renderWindChart(container, data, xAxis);
    }

    renderWindChart(container, data, xAxis = "time") {
        if (!window.Plot) {
            console.error("Observable Plot not available");
            return;
        }

        const plot = Plot.plot({
            width: container.clientWidth,
            height: this.CONSTANTS.CHART_HEIGHT,
            marginLeft: 30,
            marginRight: 10,
            marginBottom: 50,
            marginTop: 30,
            x: {
                label: xAxis === "time" ? "Time" : "Distance (km)",
                type: xAxis === "time" ? "utc" : "linear"
            },
            y: {
                label: "Wind Faced (km/h)",
                grid: true,
                tickFormat: d => `${d > 0 ? "+" : ""}${d.toFixed(0)}`,
                nice: true
            },
            color: {
                domain: ["headwind", "tailwind"],
                // range: ["#D55E00", "#0072B2"]
            },
            marks: [
                Plot.ruleY([0], { stroke: "#666", strokeWidth: 2 }),
                Plot.line(data, {
                    x: "x",
                    y: "y",
                    stroke: "#1976d2",
                    strokeWidth: 3,
                    curve: "step-before"
                }),
                Plot.ruleX(data, Plot.pointerX({
                    x: "x",
                    stroke: "#ff4757",
                    strokeWidth: 2,
                    strokeDasharray: "5,3"
                })),
                Plot.dot(data, Plot.pointerX({
                    x: "x",
                    y: "y",
                    r: 6,
                    fill: "#ff4757",
                    stroke: "#fff",
                    strokeWidth: 2
                })),
                Plot.text(data, Plot.pointerX({
                    x: "x",
                    y: "y",
                    dy: -15,
                    text: d => `${d.y >= 0 ? '+' : ''}${d.y.toFixed(1)} km/h`,
                    fill: "#000",
                    fontSize: 12,
                    fontWeight: "bold",
                    textAnchor: "middle"
                }))
            ]
        });

        container.innerHTML = "";
        container.appendChild(plot);
        this.addMapInteraction(container, data);
        this.charts.wind = plot;
    }

    addMapInteraction(container, data) {
        // Store the SVG element for accurate coordinate mapping
        let plotSVG = null;

        // Identify which chart this is for debugging
        const chartId = container.id || 'unknown';

        // Find the SVG element created by Observable Plot
        const findPlotSVG = () => {
            if (!plotSVG) {
                plotSVG = container.querySelector('svg');
            }
            return plotSVG;
        };

        const handlePointerMove = (event) => {
            const svg = findPlotSVG();
            if (!svg) return;

            // Get SVG-relative coordinates using getBoundingClientRect for accuracy
            const svgRect = svg.getBoundingClientRect();
            const mouseX = event.clientX - svgRect.left;

            // Get the viewBox or fallback to SVG dimensions
            const viewBox = svg.viewBox.baseVal;
            const svgWidth = viewBox.width || parseFloat(svg.getAttribute('width')) || svgRect.width;
            const svgHeight = viewBox.height || parseFloat(svg.getAttribute('height')) || svgRect.height;

            // Use the actual chart margins (matching the chart configuration)
            let marginLeft = 30, marginRight = 10; // Updated to match chart settings

            // Try to get actual margins from the plot group transform if available
            const plotGroup = svg.querySelector('g[aria-label="plot"]') || svg.querySelector('g');
            if (plotGroup) {
                const transform = plotGroup.getAttribute('transform');
                if (transform) {
                    const translateMatch = transform.match(/translate\(([^,]+),([^)]+)\)/);
                    if (translateMatch) {
                        const detectedMarginLeft = parseFloat(translateMatch[1]);
                        // Only use detected margin if it's reasonable (Observable Plot sometimes adds extra transforms)
                        if (detectedMarginLeft > 20 && detectedMarginLeft < 60) {
                            marginLeft = detectedMarginLeft;
                        }
                    }
                }
            }

            const plotWidth = svgWidth - marginLeft - marginRight;

            // Check if mouse is within the plot area
            if (mouseX >= marginLeft && mouseX <= svgWidth - marginRight && plotWidth > 0) {
                // Calculate the relative position within the plot area
                const relativeX = (mouseX - marginLeft) / plotWidth;

                // Clamp the relative position to [0, 1]
                const clampedX = Math.max(0, Math.min(1, relativeX));

                // Find the closest data point based on the X-axis value
                const dataIndex = this.findClosestDataIndex(data, clampedX);

                // Ensure we found a valid index
                if (dataIndex >= 0 && dataIndex < data.length && data[dataIndex]) {
                    const actualDataIndex = data[dataIndex].dataIndex;

                    // Debug logging to understand the issue
                    // console.log(`${chartId} hover - relativeX: ${clampedX.toFixed(3)}, dataIndex: ${dataIndex}, actualDataIndex: ${actualDataIndex}, total points: ${data.length}`);

                    // Use throttled update for better performance
                    this.throttledMapUpdate(actualDataIndex);
                }
            }
        };

        const handlePointerLeave = () => {
            this.clearMapHighlight();
        };

        // Use passive listeners for better performance
        container.addEventListener("pointermove", handlePointerMove, { passive: true });
        container.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    }

    // Helper method to find the closest data point based on relative X position
    findClosestDataIndex(data, relativeX) {
        if (!data || data.length === 0) return -1;

        // Get the range of X values in the data
        const xValues = data.map(d => d.x);

        // Handle different data types (Date objects vs numbers)
        let minX, maxX;
        if (xValues[0] instanceof Date) {
            minX = Math.min(...xValues.map(d => d.getTime()));
            maxX = Math.max(...xValues.map(d => d.getTime()));
            // Calculate the target X value based on relative position
            const targetX = minX + relativeX * (maxX - minX);

            // Find the closest data point by time
            let closestIndex = 0;
            let minDistance = Math.abs(xValues[0].getTime() - targetX);

            for (let i = 1; i < xValues.length; i++) {
                const distance = Math.abs(xValues[i].getTime() - targetX);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestIndex = i;
                }
            }
            return closestIndex;
        } else {
            // Handle numeric values (distance)
            minX = Math.min(...xValues);
            maxX = Math.max(...xValues);
            // Calculate the target X value based on relative position
            const targetX = minX + relativeX * (maxX - minX);

            // Find the closest data point by value
            let closestIndex = 0;
            let minDistance = Math.abs(xValues[0] - targetX);

            for (let i = 1; i < xValues.length; i++) {
                const distance = Math.abs(xValues[i] - targetX);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestIndex = i;
                }
            }
            return closestIndex;
        }
    }

    // Immediate update for responsiveness
    updateMapHighlightImmediate(index) {
        // Cancel any pending throttled updates
        if (this.mapUpdateTimeout) {
            clearTimeout(this.mapUpdateTimeout);
            this.mapUpdateTimeout = null;
        }

        // Only update if the index actually changed to avoid redundant updates
        if (this.lastHighlightIndex === index) {
            return;
        }

        this.lastHighlightIndex = index;
        this.updateMapHighlight(index);
    }

    clearMapHighlight() {
        if (this.currentHoverMarker && this.map) {
            try {
                this.map.removeLayer(this.currentHoverMarker);
            } catch (error) {
                console.warn("Error removing map highlight marker:", error);
            }
            this.currentHoverMarker = null;
        }
        // Reset the last highlight index
        this.lastHighlightIndex = -1;
    }

    updateMapHighlight(index) {
        if (!this.map || !this.gpxData || index < 0 || index >= this.gpxData.length || !this.gpxData[index]) {
            return;
        }

        this.clearMapHighlight();

        const point = this.gpxData[index];

        try {
            this.currentHoverMarker = L.circleMarker([point.lat, point.lon], {
                radius: 12,
                fillColor: "#ff4757",
                color: "#fff",
                weight: 3,
                opacity: 1,
                fillOpacity: 0.9
            }).addTo(this.map);

            // Add tooltip with information
            const windDirection = point.wind_faced >= 0 ? "Headwind" : "Tailwind";
            const timeStr = point.time ? point.time.toLocaleTimeString() : "N/A";
            // const windSpeed = point.wind_speed;
            // const windFromDirection = point.wind_direction;
            // const cyclistDirection = point.bearing;


            this.currentHoverMarker
                .bindTooltip(
                    `<div style="font-family: Arial, sans-serif; font-size: 12px;">
                       <strong>Speed:</strong> ${point.speed_kmh.toFixed(1)} km/h<br>
                       <strong>Elevation:</strong> ${point.elevation.toFixed(0)}m<br>
                       <strong>Wind Experienced:</strong> ${Math.abs(point.wind_faced).toFixed(1)} km/h ${windDirection}<br>
                       <strong>Time:</strong> ${timeStr}
                       </div>`,
                    //    <strong>Wind Speed:</strong> ${windSpeed.toFixed(1)} km/h<br>
                    //    <strong>Wind Direction From:</strong> ${windFromDirection.toFixed(1)}°<br>
                    //    <strong>User Direction Heading:</strong> ${cyclistDirection.toFixed(1)}°<br>
                    {
                        permanent: false,
                        direction: "top",
                        offset: [0, -15],
                        className: "custom-tooltip"
                    }
                )
                .openTooltip();
        } catch (error) {
            console.warn("Error creating map highlight marker:", error);
        }
    }

    setupChartToggles() {
        const timeBtn = document.getElementById("globalTimeBtn");
        const distanceBtn = document.getElementById("globalDistanceBtn");

        if (timeBtn) {
            timeBtn.addEventListener("click", () => {
                this.setActiveToggle("global", "time");
                this.currentXAxis = "time";
                this.recreateAllCharts("time");
            });
        }

        if (distanceBtn) {
            distanceBtn.addEventListener("click", () => {
                this.setActiveToggle("global", "distance");
                this.currentXAxis = "distance";
                this.recreateAllCharts("distance");
            });
        }
    }

    recreateAllCharts(xAxis) {
        this.createSpeedChart(xAxis);
        this.createElevationChart(xAxis);
        this.createWindChart(xAxis);
    }

    setActiveToggle(chartType, axis) {
        const buttons = document.querySelectorAll("#globalTimeBtn, #globalDistanceBtn");
        const activeClasses = ["bg-blue-600", "text-white", "border-blue-600"];
        const inactiveClasses = ["bg-gray-100", "border-gray-300", "hover:bg-blue-50", "hover:border-blue-600"];

        buttons.forEach(btn => {
            btn.classList.remove(...activeClasses);
            btn.classList.add(...inactiveClasses);
        });

        const activeBtn = document.getElementById(`global${axis.charAt(0).toUpperCase() + axis.slice(1)}Btn`);
        if (activeBtn) {
            activeBtn.classList.remove(...inactiveClasses);
            activeBtn.classList.add(...activeClasses);
        }
    }

    createMap() {
        const mapDiv = document.getElementById("map");
        if (!mapDiv) {
            console.error("Map container not found");
            return;
        }

        // Clean up existing map
        this.cleanupMap();

        // Set map container dimensions
        mapDiv.style.width = "100%";
        mapDiv.style.height = `${this.CONSTANTS.MAP_HEIGHT}px`;
        mapDiv.style.position = "relative";

        // Initialize map
        this.map = L.map("map", {
            zoomControl: true,
            attributionControl: true,
            preferCanvas: false,
            fullscreenControl: true
        });

        this.addMapTileLayer();

        if (this.gpxData.length === 0) {
            this.map.setView([51.5074, -0.1278], 10);
            this.invalidateMapSize();
            return;
        }

        this.renderRouteOnMap();
        this.addStartEndMarkers();
        this.fitMapToBounds();
        this.invalidateMapSize();
    }

    cleanupMap() {
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.currentHoverMarker = null;
    }

    addMapTileLayer() {
        const tileLayer = L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                attribution: "© OpenStreetMap contributors",
                maxZoom: 18,
                crossOrigin: true
            }
        );

        tileLayer.on("tileerror", (e) => {
            console.warn("Tile loading error:", e);
        });

        tileLayer.addTo(this.map);
    }

    renderRouteOnMap() {
        const coordinates = this.gpxData.map(p => [p.lat, p.lon]);
        this.bounds = L.latLngBounds(coordinates);

        // Create smoothed points for better visualization
        const smoothedPoints = this.createSmoothedRoutePoints();

        // Create colored line segments
        this.createColoredRouteSegments(smoothedPoints);
    }

    createSmoothedRoutePoints() {
        const smoothedPoints = [];

        for (let i = 0; i < this.gpxData.length; i++) {
            smoothedPoints.push(this.gpxData[i]);

            // Add interpolated points for smoother visualization
            if (i < this.gpxData.length - 1) {
                const current = this.gpxData[i];
                const next = this.gpxData[i + 1];
                const distance = this.haversineDistance(current.lat, current.lon, next.lat, next.lon);

                if (distance > 50) {
                    const steps = Math.min(5, Math.floor(distance / 50));
                    for (let step = 1; step < steps; step++) {
                        const ratio = step / steps;
                        smoothedPoints.push(this.interpolatePoint(current, next, ratio));
                    }
                }
            }
        }

        return smoothedPoints;
    }

    interpolatePoint(current, next, ratio) {
        return {
            lat: current.lat + (next.lat - current.lat) * ratio,
            lon: current.lon + (next.lon - current.lon) * ratio,
            wind_faced: current.wind_faced + (next.wind_faced - current.wind_faced) * ratio,
            time: new Date(current.time.getTime() + (next.time - current.time) * ratio),
            speed_kmh: current.speed_kmh + (next.speed_kmh - current.speed_kmh) * ratio,
            wind_speed: current.wind_speed + (next.wind_speed - current.wind_speed) * ratio,
            wind_direction: current.wind_direction + (next.wind_direction - current.wind_direction) * ratio,
            bearing: current.bearing + (next.bearing - current.bearing) * ratio
        };
    }

    createColoredRouteSegments(smoothedPoints) {
        for (let i = 1; i < smoothedPoints.length; i++) {
            const prevPoint = smoothedPoints[i - 1];
            const currPoint = smoothedPoints[i];
            const windFaced = currPoint.wind_faced || 0;

            const style = this.getWindColorStyle(windFaced);
            const segment = this.createRouteSegment(prevPoint, currPoint, style);

            // Add interaction for original GPS points only
            if (i < this.gpxData.length) {
                this.addSegmentInteraction(segment, i);
            }
        }
    }

    getWindColorStyle(windFaced) {
        // Wind visualization using continuous color interpolation
        let colorsList = ["#2563eb", "#9ca3af", "#facc15", "#ea580c"];


        // Define wind speed ranges for color mapping
        const minWind = -15; // Strong tailwind
        const maxWind = 15;  // Strong headwind

        // Clamp wind value to our range
        const clampedWind = Math.max(minWind, Math.min(maxWind, windFaced));

        // Normalize to 0-1 range
        const normalizedWind = (clampedWind - minWind) / (maxWind - minWind);

        // Map to color array indices (0 to 4)
        const colorIndex = normalizedWind * (colorsList.length - 1);

        // Get the two colors to interpolate between
        const lowerIndex = Math.floor(colorIndex);
        const upperIndex = Math.min(lowerIndex + 1, colorsList.length - 1);
        const ratio = colorIndex - lowerIndex;

        // Interpolate between the two colors
        const interpolatedColor = this.interpolateColors(colorsList[lowerIndex], colorsList[upperIndex], ratio);

        return { color: interpolatedColor, weight: 8 };
    }

    // Helper function to interpolate between two hex colors
    interpolateColors(color1, color2, ratio) {
        // Convert hex to RGB
        const hex1 = color1.replace('#', '');
        const hex2 = color2.replace('#', '');

        const r1 = parseInt(hex1.substr(0, 2), 16);
        const g1 = parseInt(hex1.substr(2, 2), 16);
        const b1 = parseInt(hex1.substr(4, 2), 16);

        const r2 = parseInt(hex2.substr(0, 2), 16);
        const g2 = parseInt(hex2.substr(2, 2), 16);
        const b2 = parseInt(hex2.substr(4, 2), 16);

        // Interpolate RGB values
        const r = Math.round(r1 + (r2 - r1) * ratio);
        const g = Math.round(g1 + (g2 - g1) * ratio);
        const b = Math.round(b1 + (b2 - b1) * ratio);

        // Convert back to hex
        const toHex = (n) => n.toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    createRouteSegment(prevPoint, currPoint, style) {
        return L.polyline(
            [[prevPoint.lat, prevPoint.lon], [currPoint.lat, currPoint.lon]],
            {
                color: style.color,
                weight: style.weight,
                opacity: 0.9,
                lineCap: "round",
                lineJoin: "round"
            }
        ).addTo(this.map);
    }

    addSegmentInteraction(segment, dataIndex) {
        const actualIndex = Math.min(dataIndex, this.gpxData.length - 1);

        // segment.on('mouseover', () => {
        //     this.updateMapHighlightImmediate(actualIndex);
        // });

        // segment.on('mouseout', () => {
        //     this.clearMapHighlight();
        // });

        // Add detailed popup
        this.addSegmentPopup(segment, actualIndex);
    }

    addSegmentPopup(segment, index) {
        const point = this.gpxData[index];
        if (!point) return;

        const windFaced = point.wind_faced || 0;
        const windType = windFaced >= 0 ? "HEADWIND" : "TAILWIND";
        const windTypeColor = windFaced >= 0 ? "#D55E00" : "#0072B2";

        const popupContent = this.createWindPopupContent(point, windType, windTypeColor, windFaced);
        segment.bindPopup(popupContent);
    }

    createWindPopupContent(point, windType, windTypeColor, windFaced) {
        const windFromDirection = point.wind_direction;
        const cyclistDirection = point.bearing;
        const diagramSVG = this.createWindDiagram(windFromDirection, cyclistDirection);

        return `
            <div style="font-family: Roboto, sans-serif; font-size: 13px; width: 240px;">
                <div style="text-align: center; margin-bottom: 12px;">
                    <div style="font-size: 16px; font-weight: bold; color: ${windTypeColor};">
                        ${windType}
                    </div>
                    <div style="font-size: 18px; font-weight: bold; color: ${windTypeColor};">
                        ${Math.abs(windFaced).toFixed(1)} km/h
                    </div>
                </div>
                
                <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 12px;">
                    ${diagramSVG}
                    
                    <div style="margin-left: 12px; font-size: 11px;">
                        <div style="margin-bottom: 4px;">
                            <span style="color: #D55E00;">●</span> You: ${cyclistDirection.toFixed(0)}°
                        </div>
                        <div>
                            <span style="color: #0072B2;">●</span> Wind: ${windFromDirection.toFixed(0)}°
                        </div>
                    </div>
                </div>
                
                <div style="background: #f8f9fa; padding: 8px; border-radius: 6px; margin-bottom: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="text-align: center;">
                            <div style="font-size: 11px; color: #666;">Wind Speed</div>
                            <div style="font-weight: bold;">${point.wind_speed.toFixed(1)} km/h</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 11px; color: #666;">Your Speed</div>
                            <div style="font-weight: bold;">${point.speed_kmh.toFixed(1)} km/h</div>
                        </div>
                    </div>
                </div>
                
                <div style="text-align: center; font-size: 12px; color: #666;">
                    ${point.time.toLocaleTimeString()}
                </div>
            </div>
        `;
    }

    createWindDiagram(windFromDirection, cyclistDirection) {
        const diagramSize = 60;
        const center = diagramSize / 2;
        const radius = 15; // Reduced from 18 to give more space for arrowheads

        const windAngleRad = (windFromDirection * Math.PI) / 180;
        const cyclistAngleRad = (cyclistDirection * Math.PI) / 180;

        // Position arrows at the edge of the circle
        const windArrowX = center + radius * Math.sin(windAngleRad);
        const windArrowY = center - radius * Math.cos(windAngleRad);
        const cyclistArrowX = center + radius * Math.sin(cyclistAngleRad);
        const cyclistArrowY = center - radius * Math.cos(cyclistAngleRad);

        return `
            <svg width="${diagramSize}" height="${diagramSize}" style="border: 1px solid #ddd; border-radius: 50%; background: #f8f9fa;">
                <text x="${center}" y="8" text-anchor="middle" font-size="8" fill="#666">N</text>
                <text x="${diagramSize - 4}" y="${center + 3}" text-anchor="middle" font-size="8" fill="#666">E</text>
                <text x="${center}" y="${diagramSize - 2}" text-anchor="middle" font-size="8" fill="#666">S</text>
                <text x="4" y="${center + 3}" text-anchor="middle" font-size="8" fill="#666">W</text>
                
                <!-- Wind arrow (blue) - pointing FROM the wind direction -->
                <g transform="translate(${windArrowX}, ${windArrowY}) rotate(${windFromDirection})">
                    <line x1="0" y1="-8" x2="0" y2="8" stroke="#0072B2" stroke-width="2"/>
                    <polygon points="-2,8 0,12 2,8" fill="#0072B2"/>
                </g>
                
                <!-- Cyclist arrow (orange) - pointing in travel direction -->
                <g transform="translate(${cyclistArrowX}, ${cyclistArrowY}) rotate(${cyclistDirection})">
                    <line x1="0" y1="-8" x2="0" y2="8" stroke="#D55E00" stroke-width="2"/>
                    <polygon points="-2,-8 0,-12 2,-8" fill="#D55E00"/>
                </g>
                
                <circle cx="${center}" cy="${center}" r="1.5" fill="#333"/>
            </svg>
        `;
    }

    addStartEndMarkers() {
        if (this.gpxData.length === 0) return;

        // Start marker
        L.marker([this.gpxData[0].lat, this.gpxData[0].lon], {
            icon: L.divIcon({
                className: "start-marker",
                html: '<div style="background: #4caf50; color: white; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold;">START</div>',
                iconSize: [50, 20],
                iconAnchor: [25, 20]
            })
        }).addTo(this.map).bindPopup("Start");

        // End marker
        if (this.gpxData.length > 1) {
            const lastPoint = this.gpxData[this.gpxData.length - 1];
            L.marker([lastPoint.lat, lastPoint.lon], {
                icon: L.divIcon({
                    className: "end-marker",
                    html: '<div style="background: #ff5722; color: white; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold;">END</div>',
                    iconSize: [40, 20],
                    iconAnchor: [20, 20]
                })
            }).addTo(this.map).bindPopup("End");
        }
    }

    fitMapToBounds() {
        if (this.bounds && this.bounds.isValid()) {
            setTimeout(() => {
                if (this.map) {
                    this.map.fitBounds(this.bounds, {
                        padding: [30, 30],
                        maxZoom: 15
                    });
                }
            }, 50);
        }
    }

    invalidateMapSize() {
        setTimeout(() => {
            if (this.map) {
                this.map.invalidateSize();
            }
        }, 100);
    }

    generateSummaryStats() {
        const stats = this.calculateRouteStatistics();
        const statsGrid = document.getElementById("statsGrid");

        if (!statsGrid) {
            console.warn("Stats grid element not found");
            return;
        }

        statsGrid.innerHTML = this.createStatsHTML(stats);
    }

    calculateRouteStatistics() {
        const totalDistance = this.calculateTotalDistance();
        const totalTime = (this.gpxData[this.gpxData.length - 1].time - this.gpxData[0].time) / (1000 * 60 * 60);

        const speeds = this.gpxData.map(p => p.speed_kmh).filter(s => s > 0);
        const windFacedValues = this.gpxData.map(p => p.wind_faced);
        const windSpeedValues = this.gpxData.map(p => p.wind_speed);

        return {
            totalDistance,
            totalTime,
            avgSpeed: speeds.length > 0 ? speeds.reduce((sum, s) => sum + s, 0) / speeds.length : 0,
            avgWindFaced: windFacedValues.reduce((sum, w) => sum + w, 0) / windFacedValues.length,
            maxHeadwind: Math.max(...windFacedValues.map(w => Math.max(0, w))),
            maxTailwind: Math.abs(Math.min(...windFacedValues.map(w => Math.min(0, w)))),
            avgWindSpeed: windSpeedValues.reduce((sum, w) => sum + w, 0) / windSpeedValues.length,
            headwindPercentage: (windFacedValues.filter(w => w >= 0).length / windFacedValues.length) * 100
        };
    }

    createStatsHTML(stats) {
        const statItems = [
            { value: `${stats.totalDistance.toFixed(1)} km`, label: "Total Distance" },
            { value: `${stats.totalTime.toFixed(1)} h`, label: "Total Time" },
            { value: `${stats.avgSpeed.toFixed(1)} km/h`, label: "Average Speed" },
            { value: `${stats.avgWindSpeed.toFixed(1)} km/h`, label: "Average Wind Speed" },
            { value: `${stats.avgWindFaced >= 0 ? "+" : ""}${stats.avgWindFaced.toFixed(1)} km/h`, label: "Average Wind Faced" },
            { value: `${stats.maxHeadwind.toFixed(1)} km/h`, label: "Max Headwind" },
            { value: `${stats.maxTailwind.toFixed(1)} km/h`, label: "Max Tailwind" },
            { value: `${stats.headwindPercentage.toFixed(1)}%`, label: "Time in Headwind" }
        ];

        return statItems.map(item => `
            <div class="bg-gradient-to-br from-blue-600 to-blue-400 text-white p-6 rounded-lg text-center shadow-md transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-xl">
                <div class="text-3xl font-light mb-2">${item.value}</div>
                <div class="text-sm font-medium opacity-90 uppercase tracking-wide">${item.label}</div>
            </div>
        `).join('');
    }

    calculateTotalDistance() {
        let totalDistance = 0;
        for (let i = 1; i < this.gpxData.length; i++) {
            totalDistance += this.haversineDistance(
                this.gpxData[i - 1].lat,
                this.gpxData[i - 1].lon,
                this.gpxData[i].lat,
                this.gpxData[i].lon
            );
        }
        return totalDistance / 1000; // Convert to kilometers
    }

    async analyze() {
        try {
            this.showLoading();

            await this.getWindDataEvery30Min();
            this.interpolateWindAlongRoute();
            this.createMap();
            this.createCharts();
            this.generateSummaryStats();

            this.showResults();
        } catch (error) {
            console.error("Analysis error:", error);
            this.showError(error.message);
        }
    }

    showLoading() {
        const loading = document.getElementById("loading");
        const results = document.getElementById("results");
        const upload = document.querySelector(".bg-white.rounded-lg.p-12");
        const fileDropArea = document.getElementById("fileDropArea");

        // Show loading element and its parent container
        if (loading) {
            loading.classList.remove("hidden");
            loading.classList.add("show");
        }

        // Keep the upload container visible but hide the file drop area
        if (upload) {
            upload.classList.remove("hidden");
            upload.classList.add("show");
        }

        if (fileDropArea) {
            fileDropArea.classList.add("hidden");
            fileDropArea.classList.remove("show");
        }

        // Hide results
        if (results) {
            results.classList.add("hidden");
            results.classList.remove("show");
        }
    }

    showResults() {
        const loading = document.getElementById("loading");
        const results = document.getElementById("results");
        const upload = document.querySelector(".bg-white.rounded-lg.p-12");

        // Hide loading
        if (loading) {
            loading.classList.add("hidden");
            loading.classList.remove("show");
        }

        // Hide upload container
        if (upload) {
            upload.classList.add("hidden");
            upload.classList.remove("show");
        }

        // Show results
        if (results) {
            results.classList.remove("hidden");
            results.classList.add("show");
        }
    }

    showError(message) {
        const loading = document.getElementById("loading");
        const upload = document.querySelector(".bg-white.rounded-lg.p-12");
        const fileDropArea = document.getElementById("fileDropArea");

        // Hide loading
        if (loading) {
            loading.classList.add("hidden");
            loading.classList.remove("show");
        }

        // Show upload container and file drop area again
        if (upload) {
            upload.classList.remove("hidden");
            upload.classList.add("show");
        }

        if (fileDropArea) {
            fileDropArea.classList.remove("hidden");
            fileDropArea.classList.add("show");
        }

        alert("Error during analysis: " + message);
    }

    // Cleanup method for proper resource management
    destroy() {
        this.cleanupMap();

        // Clear timeouts
        if (this.mapUpdateTimeout) {
            clearTimeout(this.mapUpdateTimeout);
        }

        // Reset data
        this.gpxData = [];
        this.windData = [];
        this.chartData = { speed: null, elevation: null, wind: null };

        console.log("CyclistWindAnalyzer destroyed and cleaned up");
    }
}

// Export the class for use in other modules
export default CyclistWindAnalyzer;
