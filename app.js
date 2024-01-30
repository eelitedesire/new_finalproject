const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const Influx = require('influx');
const moment = require('moment');

const app = express();
const port = 2000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// InfluxDB configuration
const influxConfig = {
    host: '172.17.0.1', // Replace with the actual IP address of your InfluxDB container
    port: 8086,
    database: 'homeassistant',
    username: 'admin',
    password: 'adminadmin',
};

const influx = new Influx.InfluxDB(influxConfig);

// MQTT configuration
let mqttConfig = loadMqttConfig();
let mqttClient = connectToMqtt();

// Array to store incoming messages
let incomingMessages = [];

// Express routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.post('/updateConfig', (req, res) => {
    mqttConfig = {
        mqttIp: req.body.mqttIp,
        username: req.body.username,
        password: req.body.password,
        inverterType: req.body.inverterType,
        batteryType: req.body.batteryType,
    };

    saveMqttConfig(mqttConfig);

    mqttClient.end();
    mqttClient = connectToMqtt();

    res.redirect('/status');
});

app.get('/status', (req, res) => {
    if (mqttClient) {
        res.sendFile(__dirname + '/public/success.html');
    } else {
        res.sendFile(__dirname + '/public/contact.html');
    }
});

app.get('/messages', (req, res) => {
    res.sendFile(__dirname + '/public/messages.html');
});

app.get('/api/messages', (req, res) => {
    const categoryFilter = req.query.category;
    const filteredMessages = filterMessagesByCategory(categoryFilter);
    res.json(filteredMessages);
});

app.get('/analytics', async (req, res) => {
    try {
        const startDate = moment().subtract(3, 'minutes').toISOString();
        const endDate = moment().toISOString();

        let analyticsData = await calculateAnalytics(startDate, endDate);

        // If no data for the last 30 days, fetch and append current data
        if (analyticsData.every(item => item.dailyTotal.length === 0)) {
            const currentData = await calculateAnalytics(null, null);
            analyticsData = currentData;
        }

        res.render('analytics', { analyticsData });
    } catch (error) {
        console.error('Error in /analytics route:', error.message);
        res.status(500).send('Internal Server Error: ' + error.message);
    }
});


// Define the EJS view engine settings
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
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

function loadMqttConfig() {
    try {
        const configData = fs.readFileSync('mqttConfig.json');
        return JSON.parse(configData);
    } catch (error) {
        return {};
    }
}

function saveMqttConfig(config) {
    fs.writeFileSync('mqttConfig.json', JSON.stringify(config, null, 2));
}

function connectToMqtt() {
    const { mqttIp, username, password } = mqttConfig;
    const client = mqtt.connect(`mqtt://${mqttIp}`, {
        username,
        password,
    });

    client.on('connect', () => {
        console.log('Connected to MQTT broker');
        client.subscribe('solar_assistant_DEYE/#');
    });

    client.on('message', (topic, message) => {
        const formattedMessage = `${topic}: ${message.toString()}`;
        console.log(`Received message: ${formattedMessage}`);
        incomingMessages.push(formattedMessage);
        saveMessageToInfluxDB(topic, message);
    });

    client.on('error', (err) => {
        console.error('Error connecting to MQTT broker:', err.message);
        mqttClient = null;
    });

    return client;
}

async function calculateAnalytics(startDate, endDate) {
    const topics = ['load_power', 'pv_power', 'battery_power', 'grid_power'];
    const analyticsData = [];

    const fetchPromises = topics.map(async (topic) => {
        try {
            let query = '';

            if (startDate && endDate) {
                query = `
                    SELECT SUM("value") AS total_kwh
                    FROM "state"
                    WHERE "topic" =~ /${topic}/ AND time >= '${startDate}' AND time <= '${endDate}'
                    GROUP BY time(1d)
                    FILL(null)
                `;
            } else {
                // Fetch current data
                query = `
                    SELECT "value" AS total_kwh
                    FROM "state"
                    WHERE "topic" =~ /${topic}/
                    ORDER BY time DESC
                    LIMIT 1
                `;
            }

            const result = await influx.query(query);

            const dailyTotal = result.map(row => ({
                date: moment(row.time).format('YYYY-MM-DD'),
                total_kwh: row.total_kwh || 0,
            }));

            analyticsData.push({
                topic,
                dailyTotal,
            });
        } catch (error) {
            console.error(`Error calculating analytics for ${topic}:`, error.message);
        }
    });

    try {
        await Promise.all(fetchPromises);
    } catch (error) {
        console.error('Error fetching analytics data:', error.message);
        throw error;
    }

    return analyticsData;
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
