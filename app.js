const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const Influx = require('influx');
const ejs = require('ejs');

const app = express();
const port = 8000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

const configPath = '/data/options.json';
let config;

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
    console.error('Error reading configuration file:', error);
    process.exit(1);
}

const influxConfig = {
    host: '192.168.160.55',
    port: 8086,
    database: 'homeassistant',
    username: 'admin',
    password: 'adminadmin',
};

const influx = new Influx.InfluxDB(influxConfig);
const inverter_number = config.inverter_number;
const battery_number = config.battery_number;
const mqttConfig = {
    host: config.mqtt_ip,
    port: config.mqtt_port,
    username: config.mqtt_username,
    password: config.mqtt_password,
};

let mqttClient;

let incomingMessages = [];

// Express routes

app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/charts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'charts.html'));
});

app.get('/status', (req, res) => {
    if (mqttClient && mqttClient.connected) {
        res.sendFile(path.join(__dirname, 'public', 'success.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'contact.html'));
    }
});

app.get('/messages', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});


app.get('/api/messages', (req, res) => {
    const categoryFilter = req.query.category;
    const filteredMessages = filterMessagesByCategory(categoryFilter);
    res.json(filteredMessages);
});

app.get('/analytics', async (req, res) => {
    try {
        const loadPowerData = await queryInfluxDB('solar_assistant_DEYE/total/load_power/state');
        const pvPowerData = await queryInfluxDB('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfChargeData = await queryInfluxDB('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const batteryPowerData = await queryInfluxDB('solar_assistant_DEYE/total/battery_power/state');
        const gridPowerData = await queryInfluxDB('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltageData = await queryInfluxDB('solar_assistant_DEYE/total/grid_voltage/state');

        const monthlyLoadPowerData = await getMonthlyData('solar_assistant_DEYE/total/load_power/state');
        const monthlyPvPowerData = await getMonthlyData('solar_assistant_DEYE/total/pv_power/state');
        const monthlyBatteryStateOfChargeData = await getMonthlyData('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const monthlyBatteryPowerData = await getMonthlyData('solar_assistant_DEYE/total/battery_power/state');
        const monthlyGridPowerData = await getMonthlyData('solar_assistant_DEYE/total/grid_power/state');

        const solarPvTotalDaily = await calculateTotalEnergy('solar_assistant_DEYE/total/pv_power/state', 'daily');
        const solarPvTotalWeekly = await calculateTotalEnergy('solar_assistant_DEYE/total/pv_power/state', 'weekly');
        const solarPvTotalMonthly = await calculateTotalEnergy('solar_assistant_DEYE/total/pv_power/state', 'monthly');

        const gridVoltage = await getCurrentValue('solar_assistant_DEYE/total/grid_voltage/state');

        const data = {
            loadPowerData,
            pvPowerData,
            batteryStateOfChargeData,
            batteryPowerData,
            gridPowerData,
            gridVoltageData,
            monthlyLoadPowerData,
            monthlyPvPowerData,
            monthlyBatteryStateOfChargeData,
            monthlyBatteryPowerData,
            monthlyGridPowerData,
            solarPvTotalDaily,
            solarPvTotalWeekly,
            solarPvTotalMonthly,
            gridVoltage,
        };

        res.render('analytics', { data });
    } catch (error) {
        console.error('Error fetching data from InfluxDB:', error);
        res.status(500).send('Error fetching data from InfluxDB');
    }
});

app.get('/', async (req, res) => {
    try {
        const loadPowerData = await queryInfluxDB('solar_assistant_DEYE/total/load_power/state');
        const solarProductionData = await queryInfluxDB('solar_assistant_DEYE/total/pv_power/state');
        const energyStorageData = await queryInfluxDB('solar_assistant_DEYE/total/battery_power/state');
        const gridImportData = await queryInfluxDB('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltagedata = await queryInfluxDB('solar_assistant_DEYE/total/grid_voltage/state');
        // Calculate the current values for the circle progress bars
        const loadPower = await getCurrentValue('solar_assistant_DEYE/total/load_power/state');
        const solarProduction = await getCurrentValue('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfCharge = await getCurrentValue('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const gridImport = await getCurrentValue('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltage = await getCurrentValue('solar_assistant_DEYE/total/grid_voltage/state');
        const data = {
            loadPowerData,
            solarProductionData,
            energyStorageData,
            gridImportData,
            gridVoltagedata,
            loadPower,
            solarProduction,
            batteryStateOfCharge,
            gridImport,
            gridVoltage,
        };

        res.render('energy-dashboard', { data });
    } catch (error) {
        console.error('Error fetching data from InfluxDB:', error);
        res.status(500).send('Error fetching data from InfluxDB');
    }
});

app.get('/api/realtime-data', async (req, res) => {
    try {
        const loadPower = await getCurrentValue('solar_assistant_DEYE/total/load_power/state');
        const solarProduction = await getCurrentValue('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfCharge = await getCurrentValue('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const gridImport = await getCurrentValue('solar_assistant_DEYE/total/grid_power/state');
        const gridVoltage = await getCurrentValue('solar_assistant_DEYE/total/grid_voltage/state');

        const data = {
            loadPower,
            solarProduction,
            batteryStateOfCharge,
            gridImport,
            gridVoltage,
        };

        res.json(data);
    } catch (error) {
        console.error('Error fetching real-time data:', error);
        res.status(500).send('Error fetching real-time data');
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${port}`);
    connectToMqtt();
});

function filterMessagesByCategory(category) {
    if (category && category !== 'all') {
        return incomingMessages.filter(message => {
            const keywords = getCategoryKeywords(category);
            return keywords.some(keyword => message.includes(keyword));
        });
    }
    return incomingMessages;
}

function getCategoryKeywords(category) {
    switch (category) {
        case 'inverter1':
            return ['inverter_1'];
        case 'inverter2':
            return ['inverter_2'];
        case 'loadPower':
            return ['load_power'];
        case 'gridPower':
            return ['grid_power'];
        default:
            return [];
    }
}

function connectToMqtt() {
    mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
        username: mqttConfig.username,
        password: mqttConfig.password,
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT broker');
        mqttClient.subscribe('solar_assistant_DEYE/#');
    });

    mqttClient.on('message', (topic, message) => {
        const formattedMessage = `${topic}: ${message.toString()}`;
        console.log(`Received message: ${formattedMessage}`);
        incomingMessages.push(formattedMessage);
        saveMessageToInfluxDB(topic, message);
    });

    mqttClient.on('error', (err) => {
        console.error('Error connecting to MQTT broker:', err.message);
        mqttClient = null;
    });
}

function saveMessageToInfluxDB(topic, message) {
    try {
        const parsedMessage = parseFloat(message.toString());

        if (isNaN(parsedMessage)) {
            console.error('Error parsing message payload. Not a valid number:', message.toString());
            return;
        }

        const timestamp = new Date().getTime();
        const dataPoint = {
            measurement: 'state',
            fields: { value: parsedMessage },
            tags: { topic: topic },
            timestamp: timestamp * 1000000,
        };

        influx.writePoints([dataPoint])
            .then(() => {
                console.log('Message saved to InfluxDB');
            })
            .catch((err) => {
                console.error('Error saving message to InfluxDB:', err.toString());
            });
    } catch (error) {
        console.error('Error parsing message:', error.message);
    }
}

async function queryInfluxDB(topic) {
    const query = `
     SELECT mean("value") * 2.38 AS "value"
FROM "state"
WHERE "topic" = '${topic}'
  AND time >= now() - 30d - 14h
GROUP BY time(1d)

    `;

    try {
        const result = await influx.query(query);
        return result;
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error);
        throw error;
    }
}

async function getMonthlyData(topic) {
    const query = `
    SELECT mean("value") AS "value"
    FROM "state"
    WHERE "topic" = '${topic}'
    AND time >= now() - 365d
    GROUP BY time(30d)
    `;

    try {
        const result = await influx.query(query);
        const monthlyValues = result.map(point => point.value);
        return monthlyValues;
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error);
        throw error;
    }
}

async function getCurrentValue(topic) {
    const query = `
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        ORDER BY time DESC
        LIMIT 1
    `;

    try {
        const result = await influx.query(query);
        return result[0];
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error);
        throw error;
    }
}

async function calculateTotalEnergy(topic, period) {
    let timeRange;
    switch (period) {
        case 'daily':
            timeRange = '1d';
            break;
        case 'weekly':
            timeRange = '7d';
            break;
        case 'monthly':
            timeRange = '30d';
            break;
        default:
            throw new Error('Invalid period');
    }

    const query = `
        SELECT mean("value") AS "total"
        FROM "state"
        WHERE "topic" = '${topic}'
        AND time >= now() - ${timeRange}
    `;

    try {
        const result = await influx.query(query);
        return result[0].total;
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error);
        throw error;
    }
}
